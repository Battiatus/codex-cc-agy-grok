import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildTargetCommand } from "./exec.mjs";
import { diffText, porcelainStatus, resolveScope, stashCreate } from "./git.mjs";
import { collectGarbage, prepareExecutionRoot } from "./isolation.mjs";
import { buildInvocationArgs, composePrompt } from "./invocation.mjs";
import { createCapture, parseProviderOutput } from "./parse.mjs";
import { interpretVerdict, loadSchema, validate } from "./schema.mjs";
import { jobPaths, nowIso, readJsonOrNull, updateJob, writeJsonAtomic } from "./jobs.mjs";

const MAX_CHAIN_DEPTH = 3;
const PROVIDER_TIMEOUT_MARGIN_MS = 30_000;

function chainFromEnv() {
  return (process.env.AGENT_CONNECTOR_CHAIN || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Checked before any expensive work so a rejected cycle never pays for isolation.
export function assertChainAllowed(connectorId) {
  const chain = chainFromEnv();
  if (chain.includes(connectorId)) {
    throw new Error(`Connector loop detected: ${[...chain, connectorId].join(" -> ")}`);
  }
  if (chain.length >= MAX_CHAIN_DEPTH) {
    throw new Error(`Connector chain depth exceeded (${MAX_CHAIN_DEPTH}): ${chain.join(" -> ")}`);
  }
  return chain;
}

export function terminateTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process already stopped.
    }
  }
}

async function runTarget({ config, request, paths, executionCwd, prompt, schema, chain }) {
  const plan = {
    executionCwd,
    prompt,
    mode: request.mode,
    session: request.session,
    model: request.model,
    effort: request.effort,
    budgetUsd: request.budgetUsd,
    schemaPath: schema?.jobPath || "",
    schemaInline: schema?.inline || "",
    finalMessagePath: config.capabilities?.finalMessageFile ? paths.finalMessage : "",
    providerTimeout: `${Math.ceil((request.timeoutMs + PROVIDER_TIMEOUT_MARGIN_MS) / 1000)}s`,
  };
  const built = buildInvocationArgs(config, plan);
  const mock = process.env.AGENT_CONNECTOR_MOCK;
  const invocation = mock
    ? {
      command: process.execPath,
      args: [resolve(mock), "--connector", config.id, ...built.args],
      strategy: "mock",
      resolvedFrom: resolve(mock),
    }
    : buildTargetCommand(config.binary, built.args);

  const stdoutFile = createWriteStream(paths.stdout, { flags: "a" });
  const stderrFile = createWriteStream(paths.stderr, { flags: "a" });
  const stdout = createCapture();
  const stderr = createCapture();
  let timedOut = false;

  const child = spawn(invocation.command, invocation.args, {
    cwd: executionCwd,
    detached: process.platform !== "win32",
    env: { ...process.env, AGENT_CONNECTOR_CHAIN: [...chain, config.id].join(",") },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  await updateJob(config.id, request.jobId, {
    status: "RUNNING",
    targetPid: child.pid,
    startedAt: nowIso(),
    invocationStrategy: invocation.strategy,
  });

  child.stdout.on("data", (chunk) => {
    if (request.stream) {
      process.stdout.write(chunk);
    }
    stdoutFile.write(chunk);
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (request.stream) {
      process.stderr.write(chunk);
    }
    stderrFile.write(chunk);
    stderr.push(chunk);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    terminateTree(child.pid);
  }, request.timeoutMs);

  let exit;
  try {
    exit = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    stdout.end();
    stderr.end();
    stdoutFile.end();
    stderrFile.end();
  }

  const finalMessage = plan.finalMessagePath
    ? await readFile(plan.finalMessagePath, "utf8").catch(() => "")
    : "";

  return {
    ...exit,
    timedOut,
    parsed: parseProviderOutput(config.resultAdapter, { stdout: stdout.text(), finalMessage }),
    applied: built.applied,
    stderrTail: stderr.text().slice(-4_000),
    outputTruncated: stdout.truncated(),
    invocationStrategy: invocation.strategy,
  };
}

function decideStatus({ provider, request, schemaErrors, verdict, scopeEmpty }) {
  if (provider.timedOut) return "TIMEOUT";
  if (provider.code !== 0) return "FAILED";
  if (provider.parsed.providerError) return "FAILED";
  if (scopeEmpty) return "EMPTY_SCOPE";
  if (schemaErrors && schemaErrors.length > 0) return "SCHEMA_VIOLATION";
  if (provider.parsed.denials.length > 0) return "COMPLETED_WITH_DENIALS";
  if (request.expectedResponse !== null && provider.parsed.text !== request.expectedResponse) {
    return "SEMANTIC_MISMATCH";
  }
  if (verdict && !verdict.completed) return "COULD_NOT_REVIEW";
  return "COMPLETED";
}

export async function executeJob(config, request) {
  const paths = jobPaths(config.id, request.jobId);
  let isolation = null;
  try {
    const chain = assertChainAllowed(config.id);
    await collectGarbage();

    const scope = request.mode === "review"
      ? resolveScope(request.cwd, {
        scope: request.scope,
        base: request.base,
        commit: request.commit,
      })
      : null;
    const diff = scope ? diffText(request.cwd, scope) : "";

    isolation = await prepareExecutionRoot({
      mode: request.mode,
      cwd: request.cwd,
      jobId: request.jobId,
      isolate: request.isolate,
    });

    let schema = null;
    if (request.schema) {
      const loaded = await loadSchema(request.schema);
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.schema, `${JSON.stringify(loaded.schema)}\n`, "utf8");
      schema = { ...loaded, jobPath: paths.schema, inline: JSON.stringify(loaded.schema) };
    }

    const rollbackRef = request.mode === "write" ? stashCreate(request.cwd) : null;
    const prompt = composePrompt({
      connectorId: config.id,
      mode: request.mode,
      executionCwd: isolation.executionCwd,
      sourceCommit: request.sourceCommit,
      scope,
      diff,
      schemaRaw: schema ? JSON.stringify(schema.schema, null, 2) : null,
      userPrompt: request.prompt,
      isolation: isolation.strategy,
    });

    await updateJob(config.id, request.jobId, {
      executionCwd: isolation.executionCwd,
      isolationStrategy: isolation.strategy,
      workspaceExported: isolation.exported,
      gitHistoryAvailable: isolation.gitHistoryAvailable,
      scopeKind: scope?.kind ?? null,
      rollbackRef,
    });

    const provider = await runTarget({
      config,
      request,
      paths,
      executionCwd: isolation.executionCwd,
      prompt,
      schema,
      chain,
    });

    const current = await readJsonOrNull(paths.job);
    if (current?.status === "CANCELED") return null;

    let schemaErrors = null;
    if (schema) {
      schemaErrors = provider.parsed.structured
        ? validate(schema.schema, provider.parsed.structured)
        : ["$: provider returned no JSON object matching the requested schema"];
    }
    const verdict = interpretVerdict(provider.parsed.structured);
    const status = decideStatus({
      provider,
      request,
      schemaErrors,
      verdict,
      scopeEmpty: Boolean(scope?.empty),
    });

    const filesChanged = request.mode === "write" ? porcelainStatus(request.cwd) : null;
    const cleanupError = await isolation.cleanup();
    const finishedAt = nowIso();

    const result = {
      bridgeVersion: request.bridgeVersion,
      connector: config.id,
      jobId: request.jobId,
      status,
      completed: status === "COMPLETED",
      mode: request.mode,
      sourceCwd: request.cwd,
      sourceCommit: request.sourceCommit,
      repositoryRoot: request.repositoryRoot,
      executionCwd: isolation.executionCwd,
      isolationStrategy: isolation.strategy,
      workspaceExported: isolation.exported,
      gitHistoryAvailable: isolation.gitHistoryAvailable,
      isolationOmitted: isolation.omitted,
      isolationCleanupFailed: cleanupError,
      scope: scope
        ? {
          kind: scope.kind,
          requested: scope.requested,
          base: scope.base ?? null,
          commit: scope.commit ?? null,
          fileCount: scope.files?.length ?? 0,
          untrackedCount: scope.untracked?.length ?? 0,
          added: scope.added ?? 0,
          removed: scope.removed ?? 0,
          empty: scope.empty,
          note: scope.note ?? null,
        }
        : null,
      verdict: verdict?.verdict ?? null,
      review: provider.parsed.structured ?? null,
      schemaErrors,
      response: provider.parsed.text,
      expectedResponse: request.expectedResponse,
      responseMatched: request.expectedResponse === null
        ? null
        : provider.parsed.text === request.expectedResponse,
      nativeSessionId: provider.parsed.nativeSessionId,
      permissionDenials: provider.parsed.denials,
      permissionDenialDetected: provider.parsed.denials.length > 0,
      providerNotices: provider.parsed.notices,
      providerError: provider.parsed.providerError,
      providerExitCode: provider.code,
      providerSignal: provider.signal,
      appliedOptions: provider.applied,
      invocationStrategy: provider.invocationStrategy,
      usage: provider.parsed.usage,
      costUsd: provider.parsed.costUsd,
      numTurns: provider.parsed.numTurns,
      outputTruncated: provider.outputTruncated,
      filesChanged: filesChanged ? filesChanged.map((entry) => entry.path) : null,
      rollbackRef,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stderrTail: provider.stderrTail || null,
      startedAt: current?.startedAt ?? null,
      finishedAt,
      durationMs: current?.startedAt
        ? new Date(finishedAt).getTime() - new Date(current.startedAt).getTime()
        : null,
    };

    await writeJsonAtomic(paths.result, result);
    await updateJob(config.id, request.jobId, {
      status,
      completed: result.completed,
      verdict: result.verdict,
      nativeSessionId: result.nativeSessionId,
      finishedAt,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      targetPid: null,
    });
    return result;
  } catch (error) {
    const cleanupError = isolation ? await isolation.cleanup() : null;
    const current = await readJsonOrNull(paths.job);
    if (current?.status === "CANCELED") return null;
    const finishedAt = nowIso();
    const result = {
      bridgeVersion: request.bridgeVersion,
      connector: config.id,
      jobId: request.jobId,
      status: "FAILED",
      completed: false,
      mode: request.mode,
      sourceCwd: request.cwd,
      isolationCleanupFailed: cleanupError,
      error: error instanceof Error ? error.message : String(error),
      finishedAt,
    };
    await writeJsonAtomic(paths.result, result);
    await updateJob(config.id, request.jobId, {
      status: "FAILED",
      completed: false,
      error: result.error,
      finishedAt,
      targetPid: null,
    });
    return result;
  }
}
