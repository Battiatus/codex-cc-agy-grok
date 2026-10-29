import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildTargetCommand } from "./exec.mjs";
import { changedFiles, commitAll, deleteBranch, diffText, resolveScope, treeFingerprint } from "./git.mjs";
import { collectGarbage, prepareExecutionRoot } from "./isolation.mjs";
import { buildInvocationArgs, composePrompt } from "./invocation.mjs";
import { createCapture, parseProviderOutput } from "./parse.mjs";
import { interpretVerdict, loadSchema, validate } from "./schema.mjs";
import { appendEvent, jobPaths, nowIso, readJobTails, readJsonOrNull, updateJob, writeJsonAtomic } from "./jobs.mjs";

const MAX_CHAIN_DEPTH = 3;
const PROVIDER_TIMEOUT_MARGIN_MS = 30_000;
// A prompt passed as an argument hits the OS command-line limit (32K chars on
// Windows, 128K per argument on Linux) once a diff is embedded.
const MAX_ARG_PROMPT_CHARS = process.platform === "win32" ? 30_000 : 120_000;

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

// Some CLIs read stdin as a protocol rather than raw text (agy takes one
// stream-json message), so the prompt is slotted into the declared envelope.
function stdinPayload(invocation, prompt) {
  if (!invocation.stdinTemplate) return prompt;
  return `${JSON.stringify(invocation.stdinTemplate, (key, value) => (value === "{prompt}" ? prompt : value))}\n`;
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
    promptFile: paths.promptComposed,
    providerTimeout: `${Math.ceil((request.timeoutMs + PROVIDER_TIMEOUT_MARGIN_MS) / 1000)}s`,
  };
  const promptVia = config.invocation.promptVia ?? "arg";
  const viaStdin = promptVia === "stdin";
  if (promptVia === "arg" && prompt.length > MAX_ARG_PROMPT_CHARS) {
    throw new Error(
      `${config.displayName} only accepts the prompt as an argument and this one is ${prompt.length} chars (limit ${MAX_ARG_PROMPT_CHARS}). Narrow the scope or use a provider that reads stdin.`,
    );
  }
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

  // R3: persist the exact replay artifacts BEFORE spawning, so a failure can
  // always be re-diagnosed: the composed prompt (with the embedded diff) and
  // the exact command line after resolution strategy and flag expansion.
  await writeFile(paths.promptComposed, `${prompt}\n`, "utf8").catch(() => {});
  await writeJsonAtomic(paths.invocation, {
    command: invocation.command,
    args: invocation.args,
    cwd: executionCwd,
    strategy: invocation.strategy,
    resolvedFrom: invocation.resolvedFrom ?? null,
    applied: built.applied,
    schemaPath: plan.schemaPath || null,
    finalMessagePath: plan.finalMessagePath || null,
    providerTimeout: plan.providerTimeout,
    timeoutMs: request.timeoutMs,
  }).catch(() => {});
  const emit = (kind, data) => appendEvent(request.jobId, kind, data);
  await emit("invocation-built", {
    strategy: invocation.strategy,
    command: invocation.command,
    argCount: invocation.args.length,
  });

  const stdoutFile = createWriteStream(paths.stdout, { flags: "a" });
  const stderrFile = createWriteStream(paths.stderr, { flags: "a" });
  const stdout = createCapture();
  const stderr = createCapture();
  let timedOut = false;
  let timeoutSnapshot = null;

  // R4: live heartbeat — bytes counters + last-stream timestamp, flushed to the
  // job record on a throttle so `runs`/`status` can tell "active 3s ago" from
  // "silent for 8 minutes" without touching the log files.
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastStreamAt = null;
  let lastFlushAt = 0;
  // R6: --verbose re-streams provider NDJSON events to the bridge's stderr,
  // timestamped and summarised, without touching the files the parser reads.
  let verboseBuffer = "";
  const timestamp = () => new Date().toISOString().slice(11, 23);
  const verboseSummarise = (line) => {
    let summary = line.trim();
    try {
      const parsed = JSON.parse(summary);
      const parts = [
        parsed.type,
        parsed.item?.type,
        parsed.item?.message || parsed.item?.text || parsed.message || parsed.status || "",
      ].filter((value) => typeof value === "string" && value);
      summary = parts.length ? parts.join(" / ") : line.trim();
    } catch {
      // Not JSON: print the raw line, truncated.
    }
    const bounded = summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
    process.stderr.write(`[${timestamp()}] ${bounded}\n`);
  };
  const verbosePush = (chunk) => {
    if (!request.verbose) return;
    verboseBuffer += chunk.toString("utf8");
    let index = verboseBuffer.indexOf("\n");
    while (index !== -1) {
      const line = verboseBuffer.slice(0, index);
      verboseBuffer = verboseBuffer.slice(index + 1);
      if (line.trim()) verboseSummarise(line);
      index = verboseBuffer.indexOf("\n");
    }
  };

  const HEARTBEAT_FLUSH_MS = 2_000;
  const flushHeartbeat = (force = false) => {
    const now = Date.now();
    if (!force && now - lastFlushAt < HEARTBEAT_FLUSH_MS) return;
    lastFlushAt = now;
    updateJob(request.jobId, {
      lastStreamAt,
      stdoutBytes,
      stderrBytes,
    }).catch(() => {});
  };

  const child = spawn(invocation.command, invocation.args, {
    cwd: executionCwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...(request.mode === "review" ? config.invocation.reviewEnv : config.invocation.writeEnv),
      AGENT_CONNECTOR_CHAIN: [...chain, config.id].join(","),
    },
    windowsHide: true,
    stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (viaStdin) {
    // A provider that exits before draining stdin raises EPIPE; its exit code
    // and output already tell the story.
    child.stdin.on("error", () => {});
    child.stdin.end(stdinPayload(config.invocation, prompt));
  }

  await updateJob(request.jobId, {
    status: "RUNNING",
    targetPid: child.pid,
    startedAt: nowIso(),
    invocationStrategy: invocation.strategy,
  });
  await emit("child-spawned", { pid: child.pid, startedAt: nowIso() });

  child.stdout.on("data", (chunk) => {
    if (request.stream) {
      process.stdout.write(chunk);
    }
    stdoutFile.write(chunk);
    stdout.push(chunk);
    stdoutBytes += chunk.length;
    lastStreamAt = nowIso();
    flushHeartbeat();
    verbosePush(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (request.stream) {
      process.stderr.write(chunk);
    }
    stderrFile.write(chunk);
    stderr.push(chunk);
    stderrBytes += chunk.length;
    lastStreamAt = nowIso();
    flushHeartbeat();
  });

  const timer = setTimeout(() => {
    timedOut = true;
    // R5: capture the pre-kill snapshot so TIMEOUT answers "was it stuck?"
    timeoutSnapshot = {
      timedOutAt: nowIso(),
      timeoutMs: request.timeoutMs,
      lastStreamAt,
      stdoutBytes,
      stderrBytes,
      stdoutTail: stdout.text().slice(-2_000) || null,
      stderrTail: stderr.text().slice(-2_000) || null,
    };
    updateJob(request.jobId, { timeoutSnapshot }).catch(() => {});
    emit("timeout-firing", { timeoutMs: request.timeoutMs });
    terminateTree(child.pid);
  }, request.timeoutMs);

  let exit;
  try {
    // "close", not "exit": stdio may still be draining at exit, and a chunk
    // written to the log after .end() would crash the worker.
    exit = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("close", (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    stdout.end();
    stderr.end();
    stdoutFile.end();
    stderrFile.end();
    flushHeartbeat(true);
    if (request.verbose && verboseBuffer.trim()) verboseSummarise(verboseBuffer);
    verboseBuffer = "";
    await emit("child-exit", {
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      timedOut,
      stdoutBytes,
      stderrBytes,
      lastStreamAt,
    });
  }

  const finalMessage = plan.finalMessagePath
    ? await readFile(plan.finalMessagePath, "utf8").catch(() => "")
    : "";

  return {
    ...exit,
    timedOut,
    timeoutSnapshot,
    lastStreamAt,
    stdoutBytes,
    stderrBytes,
    parsed: parseProviderOutput(config.resultAdapter, { stdout: stdout.text(), finalMessage }),
    applied: built.applied,
    stderrTail: stderr.text().slice(-4_000),
    outputTruncated: stdout.truncated(),
    invocationStrategy: invocation.strategy,
    invocationPath: paths.invocation,
    promptComposedPath: paths.promptComposed,
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

function commitMessage(request) {
  return `polyglot: ${request.connector} job ${request.jobId}`;
}

// filesChanged is the exact diff between the base the agent started from and
// its branch, so pre-existing user edits never show up as the agent's work. A
// branch with no change is deleted rather than left as noise; a branch whose
// diff could not be read is kept.
function settleBranch(cwd, { branch, baseRef }) {
  const filesChanged = changedFiles(cwd, baseRef, branch);
  if (filesChanged && filesChanged.length === 0) {
    deleteBranch(cwd, branch);
    return { branch: null, baseRef, filesChanged };
  }
  return { branch, baseRef, filesChanged };
}

// Commits the agent's work and removes the worktree. When the commit fails the
// worktree is the only copy of that work, so it is kept and reported instead.
async function finishWrite(request, isolation) {
  const commitError = commitAll(isolation.executionCwd, commitMessage(request));
  if (commitError) {
    return {
      commitError: `Could not commit the agent's changes (${commitError}). They are kept in ${isolation.executionCwd} until garbage collection (6h).`,
      cleanupError: null,
      write: { branch: isolation.branch, baseRef: isolation.baseRef, filesChanged: null },
    };
  }
  const cleanupError = await isolation.cleanup();
  return { commitError: null, cleanupError, write: settleBranch(request.cwd, isolation) };
}

export async function executeJob(config, request) {
  const paths = jobPaths(request.jobId);
  let isolation = null;
  // Set once the write branch is settled, so a later failure never redoes it.
  let finished = null;
  const emit = (kind, data) => appendEvent(request.jobId, kind, data);
  // R1: track the failing phase so the failure record says WHERE it broke.
  let phase = "init";
  try {
    const chain = assertChainAllowed(config.id);
    await collectGarbage();
    await emit("job-started", { mode: request.mode, cwd: request.cwd });

    phase = "resolve-scope";
    const scope = request.mode === "review"
      ? resolveScope(request.cwd, {
        scope: request.scope,
        base: request.base,
        commit: request.commit,
      })
      : null;
    // NB: no "kind" key in event data — it would shadow the event kind itself.
    await emit("scope-resolved", {
      scopeKind: scope?.kind ?? null,
      fileCount: scope?.files?.length ?? 0,
      empty: scope?.empty ?? null,
    });
    const diff = scope ? diffText(request.cwd, scope) : "";

    phase = "isolate";
    isolation = await prepareExecutionRoot({
      mode: request.mode,
      cwd: request.cwd,
      jobId: request.jobId,
      isolate: request.isolate,
    });
    await emit("isolation-ready", { strategy: isolation.strategy, executionCwd: isolation.executionCwd });

    phase = "schema";
    let schema = null;
    if (request.schema) {
      const loaded = await loadSchema(request.schema);
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.schema, `${JSON.stringify(loaded.schema)}\n`, "utf8");
      schema = { ...loaded, jobPath: paths.schema, inline: JSON.stringify(loaded.schema) };
    }

    phase = "compose-prompt";
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
    await emit("prompt-composed", { length: prompt.length });

    await updateJob(request.jobId, {
      executionCwd: isolation.executionCwd,
      isolationStrategy: isolation.strategy,
      workspaceExported: isolation.exported,
      gitHistoryAvailable: isolation.gitHistoryAvailable,
      scopeKind: scope?.kind ?? null,
      branch: isolation.branch ?? null,
      baseRef: isolation.baseRef ?? null,
    });

    // The bridge never writes the source tree; this catches a provider that did.
    const sourceBefore = isolation.branch ? treeFingerprint(request.cwd) : null;
    phase = "provider";
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
    const decided = decideStatus({
      provider,
      request,
      schemaErrors,
      verdict,
      scopeEmpty: Boolean(scope?.empty),
    });

    phase = isolation.branch ? "commit" : "cleanup";
    finished = isolation.branch
      ? await finishWrite(request, isolation)
      : { commitError: null, cleanupError: await isolation.cleanup(), write: null };
    const { commitError, cleanupError, write } = finished;
    const sourceTreeModified = sourceBefore !== null && treeFingerprint(request.cwd) !== sourceBefore;
    const status = commitError ? "FAILED" : decided;
    await emit("status-decided", { status, schemaErrorCount: schemaErrors?.length ?? 0 });
    await emit("cleanup-done", { failed: Boolean(cleanupError), commitFailed: Boolean(commitError) });
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
      timeoutSnapshot: provider.timeoutSnapshot,
      branch: write?.branch ?? null,
      baseRef: write?.baseRef ?? null,
      filesChanged: write?.filesChanged ?? null,
      sourceTreeModified,
      error: commitError,
      phase: commitError ? "commit" : null,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      invocationPath: provider.invocationPath,
      promptComposedPath: provider.promptComposedPath,
      stderrTail: provider.stderrTail || null,
      startedAt: current?.startedAt ?? null,
      finishedAt,
      durationMs: current?.startedAt
        ? new Date(finishedAt).getTime() - new Date(current.startedAt).getTime()
        : null,
    };

    await writeJsonAtomic(paths.result, result);
    await updateJob(request.jobId, {
      status,
      completed: result.completed,
      verdict: result.verdict,
      nativeSessionId: result.nativeSessionId,
      finishedAt,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      usage: result.usage,
      branch: result.branch,
      stdoutBytes: provider.stdoutBytes,
      stderrBytes: provider.stderrBytes,
      targetPid: null,
    });
    await emit("finished", { status, completed: result.completed });
    return result;
  } catch (error) {
    // Partial work a failed write job left behind stays inspectable on its branch
    // (or in its worktree when even the commit fails).
    const { commitError, cleanupError, write } = finished ?? (isolation?.branch
      ? await finishWrite(request, isolation)
      : { commitError: null, cleanupError: isolation ? await isolation.cleanup() : null, write: null });
    const current = await readJsonOrNull(paths.job);
    if (current?.status === "CANCELED") return null;
    const finishedAt = nowIso();
    // R1: a failure record must be self-sufficient — phase, stack, log paths
    // and tails, and the replay artifacts when they were already written.
    const tails = await readJobTails(request.jobId).catch(() => null);
    const result = {
      bridgeVersion: request.bridgeVersion,
      connector: config.id,
      jobId: request.jobId,
      status: "FAILED",
      completed: false,
      mode: request.mode,
      sourceCwd: request.cwd,
      isolationCleanupFailed: cleanupError,
      phase,
      error: [error instanceof Error ? error.message : String(error), commitError].filter(Boolean).join(" "),
      errorStack: error instanceof Error ? error.stack : null,
      executionCwd: isolation?.executionCwd ?? null,
      branch: write?.branch ?? null,
      baseRef: write?.baseRef ?? null,
      filesChanged: write?.filesChanged ?? null,
      stdoutPath: paths.stdout,
      stderrPath: paths.stderr,
      stdoutTail: tails?.stdoutTail || null,
      stderrTail: tails?.stderrTail || null,
      invocationPath: paths.invocation,
      promptComposedPath: paths.promptComposed,
      finishedAt,
    };
    await emit("failed", { phase, error: result.error });
    await writeJsonAtomic(paths.result, result);
    await updateJob(request.jobId, {
      status: "FAILED",
      completed: false,
      error: result.error,
      finishedAt,
      targetPid: null,
    });
    return result;
  }
}
