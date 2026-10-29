import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMANDS, parseArgs, parseDuration, parsePositiveNumber, requireEnum } from "./lib/args.mjs";
import { REVIEW_SCOPES, head, repositoryRoot } from "./lib/git.mjs";
import { collectGarbage, discardWriteTarget } from "./lib/isolation.mjs";
import {
  TERMINAL_STATUSES,
  decorateJob,
  jobPaths,
  listJobs,
  newJobId,
  nowIso,
  readEvents,
  readJobTails,
  reapStaleJobs,
  readJson,
  readJsonOrNull,
  settleFinishedJob,
  sha256,
  stateRoot,
  updateJob,
  writeJsonAtomic,
} from "./lib/jobs.mjs";
import { executeJob, terminateTree } from "./lib/provider.mjs";
import { renderResult, renderRunsDashboard, renderSetup } from "./lib/render.mjs";
import { auditFlags, inspectConnector } from "./lib/setup.mjs";
import { TRANSFER_HOSTS, buildHandoffDigest, composeHandoffPrompt } from "./lib/transfer.mjs";

const BRIDGE_VERSION = "0.4.0";
const MODES = ["review", "write"];
const FORMATS = ["json", "markdown"];
const DEFAULT_REVIEW_PROMPT = "Review the change in scope and report every defect you can justify.";
// Below the 10-minute ceiling hosts put on a single shell call.
const DEFAULT_WAIT_MS = 9 * 60 * 1000;
const WAIT_POLL_MS = 1_000;
const JOB_COMMANDS = new Set(["run", "review", "adversarial-review", "rescue", "resume", "handoff"]);

// Exit codes let scripts branch without parsing JSON: 0 completed, 2 finished
// without completing, 3 still running when wait gave up.
const EXIT_NOT_COMPLETED = 2;
const EXIT_PENDING = 3;

function providersDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "providers");
}

export function providerIds() {
  return readdirSync(providersDirectory())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

// The id comes from the command line, so it is matched against the shipped
// files instead of being joined into a path.
async function loadProvider(id) {
  const ids = providerIds();
  if (!id) throw new Error(`--to is required. Expected one of ${ids.join(", ")}.`);
  if (!ids.includes(id)) throw new Error(`Unknown provider: ${id}. Expected one of ${ids.join(", ")}.`);
  return JSON.parse(await readFile(join(providersDirectory(), `${id}.json`), "utf8"));
}

async function selectedProviders(options) {
  const ids = options.to ? [options.to] : providerIds();
  return Promise.all(ids.map(loadProvider));
}

function print(value, format, renderer) {
  if (format === "markdown" && renderer) {
    process.stdout.write(`${renderer(value)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function normalizeRequest(config, options, { defaultSchema = null, promptOverride = null } = {}) {
  const prompt = promptOverride ?? (options.prompt || options._.join(" "));
  if (!prompt) throw new Error('A prompt is required (--prompt "...").');

  const cwd = resolve(options.cwd || process.cwd());
  const mode = requireEnum("mode", options.mode, MODES, "review");
  if (mode === "write" && !options["confirm-write"]) {
    throw new Error("Write mode requires the explicit --confirm-write flag.");
  }

  const capabilities = config.capabilities || {};
  if (options.model && !capabilities.model) {
    throw new Error(`${config.displayName} does not support --model.`);
  }
  if (options.effort) {
    if (!capabilities.effort) throw new Error(`${config.displayName} does not support --effort.`);
    requireEnum("effort", options.effort, config.effortValues, options.effort);
  }
  const budgetUsd = parsePositiveNumber("--max-budget-usd", options["max-budget-usd"]);
  if (budgetUsd !== null && !capabilities.budgetUsd) {
    throw new Error(`${config.displayName} does not support --max-budget-usd.`);
  }

  const schema = options.schema ?? defaultSchema;
  if (schema && capabilities.structuredOutput === "none") {
    throw new Error(`${config.displayName} does not support structured output.`);
  }
  // Refs reach git as arguments; one starting with "-" would be read as an option.
  for (const flag of ["base", "commit"]) {
    if (String(options[flag] ?? "").startsWith("-")) throw new Error(`Invalid --${flag}: ${options[flag]}`);
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    jobId: newJobId(config.id),
    connector: config.id,
    prompt,
    promptHash: sha256(prompt),
    promptLength: prompt.length,
    cwd,
    repositoryRoot: repositoryRoot(cwd),
    sourceCommit: head(cwd),
    mode,
    isolate: Boolean(options.isolate),
    stream: Boolean(options.stream),
    verbose: Boolean(options.verbose),
    scope: requireEnum("scope", options.scope, REVIEW_SCOPES, "auto"),
    base: options.base ?? null,
    commit: options.commit ?? null,
    schema: schema ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    budgetUsd,
    session: options.session ?? null,
    expectedResponse: options["expect-response"] ?? null,
    timeoutMs: parseDuration(options.timeout),
    createdAt: nowIso(),
  };
}

async function createJobRecord(config, request) {
  const paths = jobPaths(request.jobId);
  await mkdir(paths.directory, { recursive: true });
  await writeJsonAtomic(paths.job, {
    bridgeVersion: BRIDGE_VERSION,
    connector: config.id,
    jobId: request.jobId,
    status: "QUEUED",
    completed: false,
    mode: request.mode,
    scopeKind: null,
    verdict: null,
    sourceCwd: request.cwd,
    repositoryRoot: request.repositoryRoot,
    sourceCommit: request.sourceCommit,
    prompt: request.prompt,
    promptHash: request.promptHash,
    promptLength: request.promptLength,
    expectedResponse: request.expectedResponse,
    schema: request.schema,
    model: request.model,
    effort: request.effort,
    contextOrigin: request.contextOrigin ?? null,
    nativeSessionId: request.session,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  });
  return paths;
}

async function startBackground(config, request) {
  const paths = await createJobRecord(config, request);
  await writeJsonAtomic(paths.request, request);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "__worker", "--request", paths.request],
    { cwd: dirname(fileURLToPath(import.meta.url)), detached: true, env: process.env, windowsHide: true, stdio: "ignore" },
  );
  child.unref();
  return updateJob(request.jobId, { workerPid: child.pid });
}

async function runForeground(config, request) {
  await createJobRecord(config, request);
  await updateJob(request.jobId, { workerPid: process.pid });
  return executeJob(config, request);
}

// The processes die first, so no live writer can race the CANCELED record. The
// worker goes before the provider: killed the other way round, it would see the
// provider exit and record its own terminal status first.
async function cancel(jobId) {
  if (!jobId) throw new Error("A job id is required.");
  const paths = jobPaths(jobId);
  const job = await readJson(paths.job);
  if (TERMINAL_STATUSES.has(job.status)) return job;
  terminateTree(job.workerPid);
  terminateTree(job.targetPid);
  // The worker may have finished between the first read and the kill: its
  // result (and a write job's branch) then stands.
  const settled = await settleFinishedJob(jobId);
  if (settled) return settled;
  if (job.mode === "write") discardWriteTarget(job.sourceCwd, jobId);
  const canceledAt = nowIso();
  await writeJsonAtomic(paths.result, {
    bridgeVersion: BRIDGE_VERSION,
    connector: job.connector,
    jobId,
    status: "CANCELED",
    completed: false,
    mode: job.mode,
    sourceCwd: job.sourceCwd,
    canceledAt,
    finishedAt: canceledAt,
  });
  return updateJob(jobId, {
    status: "CANCELED",
    completed: false,
    branch: null,
    canceledAt,
    finishedAt: canceledAt,
    targetPid: null,
    workerPid: null,
  });
}

async function getResult(jobId) {
  if (!jobId) throw new Error("A job id is required.");
  const paths = jobPaths(jobId);
  const result = await readJsonOrNull(paths.result);
  if (result) return result;
  const job = await readJson(paths.job);
  return {
    connector: job.connector,
    jobId,
    status: job.status,
    completed: false,
    message: "No terminal result is available yet.",
    hint: `Use "wait ${jobId}" to block until it finishes, or "status ${jobId}" for live tails.`,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
  };
}

async function inspectJob(jobId, { tailLines = 15 } = {}) {
  const paths = jobPaths(jobId);
  const job = await readJsonOrNull(paths.job);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  const result = await readJsonOrNull(paths.result);
  const { stdoutTail, stderrTail } = await readJobTails(jobId, { lines: tailLines });
  const decorated = decorateJob(job);

  return {
    ...decorated,
    ...(result || {}),
    status: job.status,
    completed: job.completed ?? result?.completed ?? false,
    hostPid: decorated.hostPid,
    liveDurationMs: decorated.liveDurationMs,
    durationMs: job.durationMs ?? result?.durationMs ?? decorated.liveDurationMs ?? null,
    model: job.model ?? result?.model ?? null,
    prompt: job.prompt ?? null,
    stdoutTail: stdoutTail || null,
    stderrTail: stderrTail || null,
  };
}

// Blocks until every job is terminal or the deadline passes. Terminal jobs come
// back as their full stored result, so one call replaces status/result polling.
async function waitForJobs(jobIds, timeoutMs) {
  if (jobIds.length === 0) throw new Error("wait needs at least one job id.");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jobs = await Promise.all(jobIds.map(async (jobId) => {
      const job = await readJsonOrNull(jobPaths(jobId).job);
      if (!job) throw new Error(`Job not found: ${jobId}`);
      return job;
    }));
    const pending = jobs.filter((job) => !TERMINAL_STATUSES.has(job.status));
    if (pending.length === 0 || Date.now() >= deadline) {
      const reports = await Promise.all(jobs.map((job) => (TERMINAL_STATUSES.has(job.status)
        ? getResult(job.jobId)
        : decorateJob(job))));
      return { done: pending.length === 0, pending: pending.map((job) => job.jobId), jobs: reports };
    }
    await new Promise((done) => setTimeout(done, WAIT_POLL_MS));
  }
}

function renderWait(report) {
  const finished = report.jobs.length - report.pending.length;
  const header = `**${finished}/${report.jobs.length} finished**${report.done ? "" : ` — still running: ${report.pending.map((id) => `\`${id}\``).join(", ")}. Call wait again.`}`;
  return [header, ...report.jobs.map(renderResult)].join("\n\n---\n\n");
}

// R2: live-follow a job's orchestration journal until it reaches a terminal
// status. One NDJSON line per event; prints each new event as it lands.
async function followJob(jobId, { format = "json", intervalMs = 1_000 } = {}) {
  let offset = 0;
  const printEvent = (event) => {
    if (format === "markdown") {
      const extra = Object.entries(event)
        .filter(([key]) => !["ts", "jobId", "kind"].includes(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      process.stdout.write(`\`${event.ts}\` **${event.kind}**${extra ? ` — ${extra}` : ""}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  for (;;) {
    const { events, offset: nextOffset } = await readEvents(jobId, { offset });
    offset = nextOffset;
    for (const event of events) printEvent(event);

    const job = await readJsonOrNull(jobPaths(jobId).job);
    if (job && TERMINAL_STATUSES.has(job.status)) {
      process.stdout.write(JSON.stringify({ kind: "follow-end", status: job.status }) + "\n");
      return job.status;
    }
    await new Promise((done) => setTimeout(done, intervalMs));
  }
}

function helpText() {
  const to = `--to ${providerIds().join("|")}`;
  return {
    bridgeVersion: BRIDGE_VERSION,
    providers: providerIds(),
    usage: [
      "setup [--to <provider>] [--format json|markdown]",
      "doctor [--to <provider>]",
      `capabilities ${to}`,
      `review ${to} [--prompt "<focus>"] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--cwd <path>] [--isolate] [--model <m>] [--effort <e>] [--background] [--timeout 10m] [--format json|markdown]`,
      `adversarial-review ${to} [--focus "<area>"] [review options]`,
      `rescue ${to} --confirm-write [--prompt "<task>"] [--error "<trace>"] [--test "<command>"] [run options]`,
      `run ${to} --prompt "<task>" [--mode review|write --confirm-write] [--schema review|<path>] [--expect-response <text>] [--stream] [--verbose] [review options]`,
      `resume ${to} --session <native-id> --prompt "<follow-up>" [run options]`,
      `handoff ${to} --from-host claude|codex|grok|agy [--source <path>] --prompt "<task>" [run options]`,
      "wait <job-id>... [--timeout 9m] [--format json|markdown]",
      "runs [--all] [--reap] [--cwd <path>] [--format json|markdown]",
      "status [job-id] [--all] [--reap] [--tail <lines>] [--follow] [--format json|markdown]",
      "result <job-id> [--format json|markdown]",
      "cancel <job-id>",
    ],
    safety: [
      "review is the default mode and never writes; the provider runs with a read-only tool profile.",
      "review runs in place by default so git history stays available and nothing is exported; --isolate creates a detached git worktree, or a credential-filtered copy outside git.",
      "write requires --confirm-write and runs in a worktree on a polyglot/<job-id> branch; the bridge never writes the working tree and flags sourceTreeModified if the agent did.",
      "completed:true requires a schema-valid payload whose verdict is not could-not-review; exit code 0 means COMPLETED, 2 finished without completing, 3 still running.",
    ],
  };
}

async function runJobCommand(command, options, format) {
  const config = await loadProvider(options.to);
  if (command === "resume" && !options.session) {
    throw new Error("resume requires --session <native-id>.");
  }

  let promptOverride = null;
  let handoff = null;
  if (command === "handoff") {
    const fromHost = requireEnum("--from-host", options["from-host"], TRANSFER_HOSTS, undefined);
    const cwd = resolve(options.cwd || process.cwd());
    handoff = await buildHandoffDigest({
      fromHost,
      source: options.source ?? null,
      // The session hook records by repository root, so a subdirectory finds it.
      cwd: repositoryRoot(cwd) || cwd,
    });
    const task = options.prompt || options._.join(" ");
    if (!task) throw new Error('handoff requires --prompt "<task>".');
    promptOverride = composeHandoffPrompt(handoff, task);
  }
  if (command === "review" && !options.prompt && options._.length === 0) {
    promptOverride = DEFAULT_REVIEW_PROMPT;
  }
  if (command === "adversarial-review") {
    const focus = options.focus || "security, edge cases, vulnerability analysis, race conditions, failure modes";
    const userPrompt = options.prompt || options._.join(" ");
    promptOverride = [
      `Conduct an adversarial Red Team code review focused on: ${focus}.`,
      userPrompt ? `Context / instructions: ${userPrompt}` : null,
      "Thoroughly inspect the code for critical vulnerabilities, security defects, edge cases, exploit vectors, and failure modes. Report every valid defect you can justify.",
    ].filter(Boolean).join("\n");
  }
  if (command === "rescue") {
    options.mode = "write";
    const errorContext = options.error ? `\nError log / stack trace:\n${options.error}` : "";
    const testContext = options.test ? `\nFailing test command:\n${options.test}` : "";
    const userTask = options.prompt || options._.join(" ") || "Diagnose and fix the failure.";
    promptOverride = `Rescue operation: ${userTask}${errorContext}${testContext}\nDiagnose the root cause, make minimal targeted fixes to resolve the errors/failing tests, and verify the fix. Report all touched files.`;
  }

  const isReview = command === "review" || command === "adversarial-review";
  const structured = config.capabilities?.structuredOutput !== "none";
  const request = normalizeRequest(config, options, {
    defaultSchema: isReview && structured ? "review" : null,
    promptOverride,
  });
  if (isReview) request.mode = "review";
  if (handoff) {
    request.contextOrigin = handoff.contextOrigin;
    request.handoffFromHost = handoff.fromHost;
    request.handoffSource = handoff.sourcePath;
  }

  if (options.background) {
    print(await startBackground(config, request), format, renderResult);
    return;
  }
  const result = await runForeground(config, request);
  print(result, format, renderResult);
  if (!result?.completed) process.exitCode = EXIT_NOT_COMPLETED;
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  const format = requireEnum("format", options.format, FORMATS, "json");

  if (command === "help" || options.help) {
    print(helpText(), "json");
    return;
  }

  if (command === "capabilities") {
    const config = await loadProvider(options.to);
    print({
      connector: config.id,
      displayName: config.displayName,
      bridgeVersion: BRIDGE_VERSION,
      binary: config.binary,
      resultAdapter: config.resultAdapter,
      promptVia: config.invocation?.promptVia ?? "arg",
      capabilities: config.capabilities,
      effortValues: config.effortValues,
      reviewScopes: REVIEW_SCOPES,
      transferHosts: TRANSFER_HOSTS,
    }, "json");
    return;
  }

  if (command === "setup") {
    const reports = (await selectedProviders(options)).map((config) => inspectConnector(config));
    if (format === "markdown") {
      process.stdout.write(`${reports.map(renderSetup).join("\n\n")}\n`);
    } else {
      print(options.to ? reports[0] : reports, "json");
    }
    return;
  }

  if (command === "doctor") {
    const providers = (await selectedProviders(options)).map((config) => ({
      ...inspectConnector(config),
      flagAudit: auditFlags(config),
    }));
    print({
      providers,
      staleJobsReaped: await reapStaleJobs(),
      isolationGarbageRemoved: await collectGarbage(),
      stateRoot: stateRoot(),
    }, "json");
    return;
  }

  if (command === "__worker") {
    const requestPath = resolve(options.request);
    const request = await readJson(requestPath);
    await rm(requestPath, { force: true });
    await executeJob(await loadProvider(request.connector), request);
    return;
  }

  if (JOB_COMMANDS.has(command)) {
    await runJobCommand(command, options, format);
    return;
  }

  if (command === "wait") {
    const timeoutMs = options.timeout ? parseDuration(options.timeout) : DEFAULT_WAIT_MS;
    const report = await waitForJobs(options._, timeoutMs);
    print(report, format, renderWait);
    if (!report.done) process.exitCode = EXIT_PENDING;
    else if (report.jobs.some((job) => !job.completed)) process.exitCode = EXIT_NOT_COMPLETED;
    return;
  }

  if (command === "runs" || (command === "status" && !options._[0])) {
    if (options.reap) await reapStaleJobs();
    const runs = await listJobs({
      all: Boolean(options.all),
      repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())),
    });
    print(runs, format, renderRunsDashboard);
    return;
  }

  if (command === "status") {
    if (options.reap) await reapStaleJobs();
    const jobId = options._[0];
    if (options.follow) {
      await followJob(jobId, { format });
      return;
    }
    const tailLines = parsePositiveNumber("--tail", options.tail) ?? 15;
    print(await inspectJob(jobId, { tailLines }), format, renderResult);
    return;
  }

  if (command === "result") {
    print(await getResult(options._[0]), format, renderResult);
    return;
  }

  if (command === "cancel") {
    print(await cancel(options._[0]), format, renderResult);
    return;
  }

  throw new Error(`Unhandled command: ${command}`);
}

const directEntry = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directEntry) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "ERROR", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
