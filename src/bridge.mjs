import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMANDS, parseArgs, parseDuration, parsePositiveNumber, requireEnum } from "./lib/args.mjs";
import { REVIEW_SCOPES, head, repositoryRoot } from "./lib/git.mjs";
import { collectGarbage } from "./lib/isolation.mjs";
import {
  TERMINAL_STATUSES,
  decorateJob,
  jobPaths,
  listAllRuns,
  listJobs,
  newJobId,
  nowIso,
  readJobTails,
  reapStaleJobs,
  readJson,
  readJsonOrNull,
  sha256,
  stateRoot,
  updateJob,
  writeJsonAtomic,
} from "./lib/jobs.mjs";
import { executeJob, terminateTree } from "./lib/provider.mjs";
import { renderJobTable, renderResult, renderRunsDashboard, renderSetup } from "./lib/render.mjs";
import { auditFlags, inspectConnector } from "./lib/setup.mjs";
import { TRANSFER_HOSTS, buildHandoffDigest, composeHandoffPrompt } from "./lib/transfer.mjs";

const BRIDGE_VERSION = "0.3.0";
const MODES = ["review", "write"];
const FORMATS = ["json", "markdown"];
const DEFAULT_REVIEW_PROMPT = "Review the change in scope and report every defect you can justify.";

function pluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

async function loadConnectorConfig() {
  const direct = resolve(pluginRoot(), "connector.json");
  try {
    return JSON.parse(await readFile(direct, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const fallback = resolve(pluginRoot(), "plugins", "codex-connector", "connector.json");
      return JSON.parse(await readFile(fallback, "utf8"));
    }
    throw error;
  }
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
  const paths = jobPaths(config.id, request.jobId);
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
    { cwd: pluginRoot(), detached: true, env: process.env, windowsHide: true, stdio: "ignore" },
  );
  child.unref();
  return updateJob(config.id, request.jobId, { workerPid: child.pid });
}

async function runForeground(config, request) {
  await createJobRecord(config, request);
  await updateJob(config.id, request.jobId, { workerPid: process.pid });
  return executeJob(config, request);
}

async function cancel(config, jobId) {
  if (!jobId) throw new Error("A job id is required.");
  const paths = jobPaths(config.id, jobId);
  const job = await readJson(paths.job);
  if (TERMINAL_STATUSES.has(job.status)) return job;
  const canceledAt = nowIso();
  await writeJsonAtomic(paths.result, {
    bridgeVersion: BRIDGE_VERSION,
    connector: config.id,
    jobId,
    status: "CANCELED",
    completed: false,
    mode: job.mode,
    sourceCwd: job.sourceCwd,
    canceledAt,
    finishedAt: canceledAt,
  });
  const canceled = await updateJob(config.id, jobId, {
    status: "CANCELED",
    completed: false,
    canceledAt,
    finishedAt: canceledAt,
  });
  terminateTree(job.targetPid);
  terminateTree(job.workerPid);
  return canceled;
}

async function getResult(config, jobId) {
  if (!jobId) throw new Error("A job id is required.");
  const paths = jobPaths(config.id, jobId);
  const result = await readJsonOrNull(paths.result);
  if (result) return result;
  const job = await readJson(paths.job);
  return {
    connector: config.id,
    jobId,
    status: job.status,
    completed: false,
    message: "No terminal result is available yet.",
  };
}

async function inspectJob(defaultConnectorId, jobId, { tailLines = 15 } = {}) {
  const connectorId = jobId.includes("-") ? jobId.split("-")[0] : defaultConnectorId;
  const paths = jobPaths(connectorId, jobId);
  const job = await readJsonOrNull(paths.job);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const result = await readJsonOrNull(paths.result);
  const { stdoutTail, stderrTail } = await readJobTails(connectorId, jobId, { lines: tailLines });
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

function helpText(config) {
  return {
    connector: config.id,
    bridgeVersion: BRIDGE_VERSION,
    usage: [
      "setup [--format json|markdown]",
      "doctor",
      "capabilities",
      'review [--prompt "<focus>"] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--cwd <path>] [--isolate] [--model <m>] [--effort <e>] [--background] [--timeout 10m] [--format json|markdown]',
      'adversarial-review [--focus "<area>"] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--cwd <path>] [--isolate] [--model <m>] [--effort <e>] [--background] [--timeout 10m] [--format json|markdown]',
      'rescue [--prompt "<task>"] [--error "<trace>"] [--test "<command>"] [--cwd <path>] [--model <m>] [--effort <e>] [--background] [--timeout 10m] [--format json|markdown]',
      'run --prompt "<task>" [--mode review|write --confirm-write] [--schema review|<path>] [--expect-response <text>] [review options]',
      'resume --session <native-id> --prompt "<follow-up>" [run options]',
      'handoff --from-host claude|codex|grok|agy [--source <path>] --prompt "<task>" [run options]',
      "runs [--all] [--cwd <path>] [--format json|markdown]",
      "status [job-id] [--all] [--reap] [--tail <lines>] [--format json|markdown]",
      "result <job-id> [--format json|markdown]",
      "cancel <job-id>",
    ],
    safety: [
      "review is the default mode and never writes; the provider runs with a read-only tool profile.",
      "review runs in place by default so git history stays available and nothing is exported; --isolate creates a detached git worktree, or a credential-filtered copy outside git.",
      "write requires --mode write and --confirm-write, records a rollback ref and reports every changed file.",
      "completed:true requires a schema-valid payload whose verdict is not could-not-review; a zero exit code is never sufficient.",
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const config = await loadConnectorConfig();
  const { command, options } = parseArgs(argv);
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  const format = requireEnum("format", options.format, FORMATS, "json");

  if (command === "help" || options.help) {
    print(helpText(config), "json");
    return;
  }

  if (command === "capabilities") {
    print({
      connector: config.id,
      displayName: config.displayName,
      bridgeVersion: BRIDGE_VERSION,
      binary: config.binary,
      resultAdapter: config.resultAdapter,
      capabilities: config.capabilities,
      effortValues: config.effortValues,
      reviewScopes: REVIEW_SCOPES,
      transferHosts: TRANSFER_HOSTS,
    }, "json");
    return;
  }

  if (command === "setup") {
    print(inspectConnector(config), format, renderSetup);
    return;
  }

  if (command === "doctor") {
    print({
      ...inspectConnector(config),
      flagAudit: auditFlags(config),
      staleJobsReaped: await reapStaleJobs(config.id),
      isolationGarbageRemoved: await collectGarbage(),
      stateRoot: stateRoot(config.id),
    }, "json");
    return;
  }

  if (command === "__worker") {
    const requestPath = resolve(options.request);
    const request = await readJson(requestPath);
    await rm(requestPath, { force: true });
    await executeJob(config, request);
    return;
  }

  if (
    command === "run"
    || command === "review"
    || command === "adversarial-review"
    || command === "rescue"
    || command === "resume"
    || command === "handoff"
  ) {
    if (command === "resume" && !options.session) {
      throw new Error("resume requires --session <native-id>.");
    }

    let promptOverride = null;
    let handoff = null;
    if (command === "handoff") {
      const fromHost = requireEnum("--from-host", options["from-host"], TRANSFER_HOSTS, undefined);
      handoff = await buildHandoffDigest({
        fromHost,
        source: options.source ?? null,
        connectorId: config.id,
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
      promptOverride = userPrompt
        ? `Conduct an adversarial Red Team code review focused on: ${focus}.\nContext / instructions: ${userPrompt}\nThoroughly inspect the code for critical vulnerabilities, security defects, edge cases, exploit vectors, and failure modes. Report every valid defect you can justify.`
        : `Conduct an adversarial Red Team code review focused on: ${focus}. Thoroughly inspect the code for critical vulnerabilities, security defects, edge cases, exploit vectors, and failure modes. Report every valid defect you can justify.`;
    }
    if (command === "rescue") {
      options.mode = "write";
      options["confirm-write"] = true;
      const errorContext = options.error ? `\nError log / stack trace:\n${options.error}` : "";
      const testContext = options.test ? `\nFailing test command:\n${options.test}` : "";
      const userTask = options.prompt || options._.join(" ") || "Diagnose and fix the failure.";
      promptOverride = `Rescue operation: ${userTask}${errorContext}${testContext}\nDiagnose the root cause, make minimal targeted fixes to resolve the errors/failing tests, and verify the fix. Report all touched files.`;
    }

    const structured = config.capabilities?.structuredOutput !== "none";
    const request = normalizeRequest(config, options, {
      defaultSchema: (command === "review" || command === "adversarial-review") && structured ? "review" : null,
      promptOverride,
    });
    if (command === "review" || command === "adversarial-review") request.mode = "review";
    if (command === "rescue") request.mode = "write";
    if (handoff) {
      request.contextOrigin = handoff.contextOrigin;
      request.handoffFromHost = handoff.fromHost;
      request.handoffSource = handoff.sourcePath;
    }

    print(
      options.background ? await startBackground(config, request) : await runForeground(config, request),
      format,
      renderResult,
    );
    return;
  }

  if (command === "runs") {
    if (options.reap) await reapStaleJobs(config.id);
    const runs = await listAllRuns({
      all: Boolean(options.all),
      repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())),
    });
    print(runs, format, renderRunsDashboard);
    return;
  }

  if (command === "status") {
    if (options.reap) await reapStaleJobs(config.id);
    const jobId = options._[0];
    if (jobId) {
      const tailLines = parsePositiveNumber("--tail", options.tail) ?? 15;
      const job = await inspectJob(config.id, jobId, { tailLines });
      print(job, format, renderResult);
      return;
    }
    print(
      await listJobs(config.id, {
        all: Boolean(options.all),
        repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())),
      }),
      format,
      renderJobTable,
    );
    return;
  }

  if (command === "result") {
    print(await getResult(config, options._[0]), format, renderResult);
    return;
  }

  if (command === "cancel") {
    print(await cancel(config, options._[0]), format, renderResult);
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
