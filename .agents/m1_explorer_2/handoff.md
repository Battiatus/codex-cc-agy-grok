# Milestone 1 — Bridge Command Router Investigation & Specification Report
**Specialist**: Milestone 1 Explorer 2 (Bridge Command Router Specialist)  
**Target Scope**: `src/lib/args.mjs`, `src/bridge.mjs` (M1: Unified Runs Dashboard & Live Supervision)  
**Date**: 2026-08-30

---

## 1. Observation

Direct observations from source inspection across the codebase:

### 1.1 `src/lib/args.mjs`
- **Lines 7–15 (`BOOLEAN_FLAGS`)**:
  ```js
  const BOOLEAN_FLAGS = new Set([
    "all",
    "background",
    "confirm-write",
    "help",
    "isolate",
    "json",
    "reap",
  ]);
  ```
  `BOOLEAN_FLAGS` already includes `all` and `reap`, which are used by `runs` and `status`.
- **Lines 17–35 (`VALUE_FLAGS`)**:
  ```js
  const VALUE_FLAGS = new Set([
    "base",
    "commit",
    "cwd",
    "effort",
    "expect-response",
    "format",
    "from-host",
    "max-budget-usd",
    "mode",
    "model",
    "prompt",
    "request",
    "schema",
    "scope",
    "session",
    "source",
    "timeout",
  ]);
  ```
  `VALUE_FLAGS` does not contain `tail`. It also currently lacks `focus`, `error`, `test` (needed for M2 flagship parity).
- **Lines 37–50 (`COMMANDS`)**:
  ```js
  export const COMMANDS = new Set([
    "__worker",
    "cancel",
    "capabilities",
    "doctor",
    "handoff",
    "help",
    "result",
    "resume",
    "review",
    "run",
    "setup",
    "status",
  ]);
  ```
  `COMMANDS` is missing `"runs"` (required for Milestone 1 / R1).
- **Lines 67–104 (`parseArgs`)**:
  Strict parser that throws `Unknown option: --${key}` if a flag is not in `BOOLEAN_FLAGS` or `VALUE_FLAGS`. It supports inline syntax `--key=value`, trailing tokens in `options._`, and `--` flag delimiter.

---

### 1.2 `src/bridge.mjs`
- **Lines 6–26 (Imports)**:
  Currently imports `COMMANDS, parseArgs, parseDuration, parsePositiveNumber, requireEnum` from `./lib/args.mjs`, `renderJobTable, renderResult, renderSetup` from `./lib/render.mjs`, and job helpers from `./lib/jobs.mjs`.
  Lacks imports for `listAllRuns`, `readJobTails`, and `renderRunsDashboard`.
- **Lines 103–130 (`createJobRecord`)**:
  ```js
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
  ```
  **Critical Defect**: `prompt` string is not stored in `job.json`. Only `promptHash` and `promptLength` are written. When background workers start, `request.json` is deleted at line 263 (`await rm(requestPath, { force: true });`), causing the original prompt text to be completely lost for background and completed jobs.
- **Lines 193–216 (`helpText`)**:
  Does not list `runs` in the `usage` array.
- **Lines 268–308 (`run`, `review`, `resume`, `handoff` handlers)**:
  Foreground and background workflows create the job record via `createJobRecord` and execute.
- **Lines 310–326 (`status` command handler)**:
  ```js
  if (command === "status") {
    if (options.reap) await reapStaleJobs(config.id);
    const jobId = options._[0];
    if (jobId) {
      print(await readJson(jobPaths(config.id, jobId).job), format, renderResult);
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
  ```
  **Gaps in `status`**:
  1. When inspecting a single `jobId`: it directly calls `readJson(jobPaths(config.id, jobId).job)`. It does not calculate live duration, does not check host PID, does not merge `result.json` if available, does not resolve connectors if `jobId` belongs to another connector, and does not attach stdout/stderr log tails.
  2. When listing jobs: `listJobs` does not calculate live duration or host PID for in-flight jobs.
- **Lines 338–339**:
  Throws `Unhandled command: ${command}` for `runs`.

---

## 2. Logic Chain

1. **Argument Parsing Contract**:
   - `args.mjs` uses strict sets (`BOOLEAN_FLAGS`, `VALUE_FLAGS`, `COMMANDS`).
   - Invoking `node src/bridge.mjs runs` throws `Unknown command: runs` because `"runs"` is absent from `COMMANDS`.
   - Adding `"runs"` to `COMMANDS` enables bridge routing for the unified dashboard.
   - Invoking `node src/bridge.mjs status <jobId> --tail 25` throws `Unknown option: --tail` because `"tail"` is absent from `VALUE_FLAGS`.
   - Adding `"tail"` to `VALUE_FLAGS` enables configurable log tail length (e.g. `--tail <lines>`).

2. **Prompt Preservation in Job Store**:
   - In `src/bridge.mjs:normalizeRequest`, `request.prompt` contains the user's task prompt.
   - In `createJobRecord`, writing `prompt: request.prompt` into `job.json` guarantees persistence even after `request.json` is unlinked by background workers.
   - Preserving `prompt` in `job.json` allows both `status <jobId>` and `runs` dashboard to display full prompts and prompt summaries without external lookups.

3. **Single Job Inspection Enrichment (`status <jobId>`)**:
   - `jobId` follows the convention `${connectorId}-${timestamp}-${random}` (e.g., `codex-123...`, `claude-456...`).
   - Resolving `targetConnector = jobId.includes("-") ? jobId.split("-")[0] : config.id` ensures cross-connector inspection if `status <jobId>` is run from any connector bridge.
   - Reading `job.json` and optional `result.json` provides the static state.
   - Reading stdout and stderr tails via `readJobTails(targetConnector, jobId, tailLines)` extracts the latest log lines.
   - Calculating dynamic fields:
     - `liveDurationMs`: `!TERMINAL_STATUSES.has(job.status) && (job.startedAt || job.createdAt) ? Date.now() - new Date(job.startedAt || job.createdAt).getTime() : null`.
     - `hostPid`: `job.targetPid || job.workerPid || null`.
     - `durationMs`: `job.durationMs ?? result?.durationMs ?? null`.
     - `model`: `job.model ?? null`.
     - `prompt`: `job.prompt ?? null`.
     - `stdoutTail`: `stdoutTail || null`.
     - `stderrTail`: `stderrTail || null`.
   - Passing this enriched object to `renderResult` formats it into Markdown with live duration, PID, prompt preview, findings, and fenced code blocks for stdout/stderr tails.

4. **Multi-Connector Unified Runs Dashboard (`runs`)**:
   - `listAllRuns({ repositoryRoot, all })` aggregates runs from all connectors in `<stateRoot>/*`.
   - The `runs` handler in `src/bridge.mjs` calls `listAllRuns`, formats with `renderRunsDashboard`, and outputs the structured table:
     `| connector | job | status | pid | model | duration | scope | prompt |`.

---

## 3. Caveats

1. **Non-Existent Jobs**: If a user runs `status non-existent-job-id`, `jobPaths` will point to a missing file. `inspectJob` must handle `ENOENT` cleanly by throwing a descriptive `Job not found: <jobId>` error rather than an unhandled filesystem exception.
2. **Empty or Truncated Logs**: If a job was just queued or died before writing logs, `stdoutTail` and `stderrTail` may be empty strings. The renderer must omit stdout/stderr headings when tails are empty.
3. **Cross-Platform Pathing**: `repositoryRoot(resolve(options.cwd || process.cwd()))` must normalize backslashes/forward slashes on Windows so filtering matches `job.repositoryRoot`.

---

## 4. Conclusion & Precise Code Specifications

### 4.1 Specification for `src/lib/args.mjs`

#### Target: `src/lib/args.mjs`
```diff
--- a/src/lib/args.mjs
+++ b/src/lib/args.mjs
@@ -14,6 +14,7 @@
   "json",
   "reap",
 ]);
 
 const VALUE_FLAGS = new Set([
   "base",
   "commit",
   "cwd",
   "effort",
+  "error",
   "expect-response",
+  "focus",
   "format",
   "from-host",
   "max-budget-usd",
   "mode",
   "model",
   "prompt",
   "request",
   "schema",
   "scope",
   "session",
   "source",
+  "tail",
+  "test",
   "timeout",
 ]);
 
 export const COMMANDS = new Set([
   "__worker",
+  "adversarial-review",
   "cancel",
   "capabilities",
   "doctor",
   "handoff",
   "help",
+  "rescue",
   "result",
   "resume",
   "review",
   "run",
+  "runs",
   "setup",
   "status",
 ]);
```

---

### 4.2 Specification for `src/bridge.mjs`

#### Target: `src/bridge.mjs`

1. **Update Imports (Lines 6–27)**:
```js
import { COMMANDS, parseArgs, parseDuration, parsePositiveNumber, requireEnum } from "./lib/args.mjs";
import { REVIEW_SCOPES, head, repositoryRoot } from "./lib/git.mjs";
import { collectGarbage } from "./lib/isolation.mjs";
import {
  TERMINAL_STATUSES,
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
```

2. **Update `createJobRecord` (Lines 103–130)**:
```js
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
```

3. **Add `inspectJob` Helper Function (before `main`)**:
```js
async function inspectJob(defaultConnectorId, jobId, { tailLines = 15 } = {}) {
  const connectorId = jobId.includes("-") ? jobId.split("-")[0] : defaultConnectorId;
  const paths = jobPaths(connectorId, jobId);
  const job = await readJsonOrNull(paths.job);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  const result = await readJsonOrNull(paths.result);
  const { stdoutTail, stderrTail } = await readJobTails(connectorId, jobId, tailLines);

  const isTerminal = TERMINAL_STATUSES.has(job.status);
  const liveDurationMs = !isTerminal && (job.startedAt || job.createdAt)
    ? Date.now() - new Date(job.startedAt || job.createdAt).getTime()
    : null;
  const durationMs = job.durationMs ?? result?.durationMs ?? null;
  const hostPid = job.targetPid || job.workerPid || null;

  return {
    ...job,
    ...(result || {}),
    status: job.status,
    completed: job.completed ?? result?.completed ?? false,
    hostPid,
    liveDurationMs,
    durationMs,
    model: job.model ?? null,
    prompt: job.prompt ?? null,
    stdoutTail: stdoutTail || null,
    stderrTail: stderrTail || null,
  };
}
```

4. **Update `helpText` (Lines 193–216)**:
```js
function helpText(config) {
  return {
    connector: config.id,
    bridgeVersion: BRIDGE_VERSION,
    usage: [
      "setup [--format json|markdown]",
      "doctor",
      "capabilities",
      'review [--prompt "<focus>"] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--cwd <path>] [--isolate] [--model <m>] [--effort <e>] [--background] [--timeout 10m] [--format json|markdown]',
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
```

5. **Update Command Dispatch in `main(argv)` (Lines 310–326)**:
```js
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
```

---

## 5. Verification Method

To independently verify these changes once implemented:

1. **Unit Tests (`tests/unit.test.mjs`)**:
   - Verify `parseArgs(["runs"])` returns `{ command: "runs", options: { _: [] } }`.
   - Verify `parseArgs(["status", "job-1", "--tail", "25"])` returns `options.tail === "25"`.
   - Verify `parseArgs(["status", "--unknown"])` throws `Unknown option: --unknown`.

2. **Bridge Integration Tests (`tests/bridge.test.mjs`)**:
   - Run `node src/bridge.mjs runs` and verify it outputs valid JSON array of runs.
   - Run `node src/bridge.mjs runs --format markdown` and verify it outputs `| connector | job | status | pid | model | duration | scope | prompt |`.
   - Launch background job, run `node src/bridge.mjs status <jobId> --format markdown`, and verify live duration, PID, prompt preview, and stdout/stderr tail logs are rendered.
   - Launch background job, run `node src/bridge.mjs status <jobId>`, and verify `prompt`, `hostPid`, and `liveDurationMs` exist in the JSON output.

3. **Execution Commands**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   node --test tests/unit.test.mjs
   node --test tests/bridge.test.mjs
   ```
