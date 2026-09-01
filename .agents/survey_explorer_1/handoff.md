# Survey Explorer 1 — Specification & Bridge Architecture Investigation Report

## 1. Observation

Direct observations from codebase inspection across `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok`:

### 1.1 Project Structure & Configuration
- **`package.json`** (lines 10–17):
  ```json
  "scripts": {
    "build": "node scripts/build-plugins.mjs",
    "validate": "node scripts/validate-cross-host.mjs",
    "test": "node --test tests/unit.test.mjs tests/bridge.test.mjs tests/benchmark-parallelism.test.mjs",
    "test:real": "node --test tests/real-cli.test.mjs",
    "benchmark:parallel": "node scripts/benchmark-parallelism.mjs",
    "qa": "npm run validate && npm test"
  }
  ```
  Note: Node.js runtime is located at `C:\nvm4w\nodejs\node.exe`. Tests execute with `node --test`.

- **`benchmarks/parallel-policy.json`** (lines 1–15):
  ```json
  {
    "schemaVersion": 1,
    "parallelism": {
      "enabled": true,
      "defaultMaxConcurrentSubagents": 1,
      "activation": {
        "requiredBenchmark": "paired-single-vs-parallel",
        "minimumPairedAttempts": 5,
        "minimumEfficiencyGain": 0.2,
        "maximumRegression": 0.25,
        "correctnessRegressionAllowed": false
      }
    }
  }
  ```
  `tests/benchmark-parallelism.test.mjs` (line 35) failed when `enabled: true` was set with `defaultMaxConcurrentSubagents: 1` because the test asserted `assert.equal(report.policy.enabledByDefault, false)`. Requirement R3 specifies `enabled: true`, `defaultMaxConcurrentSubagents: 4`.

### 1.2 CLI Bridge and Command Handling
- **`src/lib/args.mjs`** (lines 7–50):
  - `COMMANDS` currently contains: `__worker`, `cancel`, `capabilities`, `doctor`, `handoff`, `help`, `result`, `resume`, `review`, `run`, `setup`, `status`.
  - Missing commands: `runs`, `adversarial-review`, `rescue`.
  - `BOOLEAN_FLAGS` currently contains: `all`, `background`, `confirm-write`, `help`, `isolate`, `json`, `reap`.
  - `VALUE_FLAGS` currently contains: `base`, `commit`, `cwd`, `effort`, `expect-response`, `format`, `from-host`, `max-budget-usd`, `mode`, `model`, `prompt`, `request`, `schema`, `scope`, `session`, `source`, `timeout`.
  - Missing flags for R1/R2: `focus`, `error`, `test`, `tail`.

- **`src/bridge.mjs`** (lines 218–339):
  - Dispatches commands: `help`, `capabilities`, `setup`, `doctor`, `__worker`, `run`, `review`, `resume`, `handoff`, `status`, `result`, `cancel`.
  - `status` command (lines 310–326):
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
  - When `status <jobId>` is called, it reads `job.json` and prints with `renderResult`.
  - Missing: No `runs` command handler. No cross-connector aggregation. No live duration calculation. No host PID enrichment. No tail stdout/stderr output.

### 1.3 Job State and Persistence
- **`src/lib/jobs.mjs`**:
  - `stateRoot(connectorId)` (lines 35–39): Returns `join(base, connectorId)` where `base` is `AGENT_CONNECTOR_HOME` or `join(tmpdir(), "agent-connectors")`.
  - `jobPaths(connectorId, jobId)` (lines 41–53):
    - `directory`: `<stateRoot>/jobs/<jobId>`
    - `job`: `job.json`
    - `request`: `request.json` (deleted by `__worker` on pickup)
    - `result`: `result.json`
    - `stdout`: `provider.stdout.ndjson`
    - `stderr`: `provider.stderr.log`
    - `finalMessage`: `provider.final.txt`
    - `schema`: `output-schema.json`
  - `createJobRecord` in `src/bridge.mjs` (lines 103–130) writes `job.json` containing: `bridgeVersion`, `connector`, `jobId`, `status: "QUEUED"`, `completed: false`, `mode`, `scopeKind`, `verdict`, `sourceCwd`, `repositoryRoot`, `sourceCommit`, `promptHash`, `promptLength`, `expectedResponse`, `schema`, `model`, `effort`, `contextOrigin`, `nativeSessionId`, `createdAt`, `updatedAt`.
  - Note: `prompt` string is not stored in `job.json` (only `promptHash` and `promptLength`). Because `request.json` is deleted by `__worker`, the full prompt text is lost after worker startup unless stored directly in `job.json`.
  - `listJobs(connectorId, { all, repositoryRoot })` (lines 153–174) only reads from `<stateRoot>/<connectorId>/jobs`.

### 1.4 Rendering & Markdown Output
- **`src/lib/render.mjs`**:
  - `renderJobTable(jobs)` (lines 126–140):
    Table format: `| job | status | verdict | mode | scope | duration | created |`
  - Missing:
    - No `renderRunsTable` / `renderRunsDashboard` for multi-connector runs dashboard.
    - `formatDuration(job.durationMs)` returns `—` for `RUNNING` or `QUEUED` jobs because `job.durationMs` is only populated at job completion.
    - No host PID, model, prompt preview, or stdout/stderr tail rendering.

### 1.5 Provider Execution & Invocation
- **`src/lib/provider.mjs`** (lines 53–155, 156–343):
  - `runTarget`: Spawns provider CLI with `child = spawn(invocation.command, invocation.args, { ... })`.
  - Streams stdout to `paths.stdout` (`provider.stdout.ndjson`) and stderr to `paths.stderr` (`provider.stderr.log`).
  - Sets `targetPid: child.pid` in `job.json` during execution.
  - On timeout: calls `terminateTree(child.pid)`.
  - On exit: parses output via `parseProviderOutput(config.resultAdapter, ...)`, evaluates status via `decideStatus(...)`, writes `result.json`, updates `job.json`.
- **`src/lib/invocation.mjs`**:
  - `buildInvocationArgs(config, plan)` expands placeholders `{cwd}`, `{prompt}`, `{session}`, `{sandbox}`, `{model}`, `{effort}`, `{schemaPath}`, `{schemaInline}`, `{finalMessagePath}`, `{budgetUsd}`, `{providerTimeout}`.
  - `composePrompt`: Builds prompt containing diff and instructions.
  - Currently lines 105–106 state:
    `"You have no shell and no git tools in this mode. Do not attempt to run commands; the diff below is the authoritative change."`
    Needs to clearly allow/encourage read tools (`read_file`, `list_dir`, `grep`) while keeping mutation tools disabled.

### 1.6 Scripts & Plugin Manifest Generator
- **`scripts/build-plugins.mjs`**:
  - Connectors defined: `codex`, `grok`, `agy`, `claude`, `qwen`, `opencode`, `copilot`.
  - `commandFiles(connector)` generates: `review.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`.
  - Missing commands in generator: `adversarial-review.md`, `rescue.md`, `runs.md`.
- **`scripts/validate-cross-host.mjs`**:
  - `REQUIRED_COMMANDS` (lines 19–27): `review.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`.
  - Validates manifests, build drift, file contents, hashes, etc.

---

## 2. Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Execution | `run` | Execute generic task in review or write mode | `--prompt <task>`, `--mode review\|write`, `--confirm-write`, `--isolate`, `--model <m>`, `--effort <e>`, `--background` | Job record or Result payload (JSON/Markdown) | Throws on write without `--confirm-write`, unknown flags, unsupported options | `src/bridge.mjs:268` |
| 2 | Code Review | `review` | Git-scoped read-only code review returning schema verdict | `[--prompt <focus>]`, `[--scope auto\|uncommitted\|staged\|branch\|commit\|workspace]`, `[--base <ref>]`, `[--commit <sha>]` | Review payload with verdict, findings, summary, next_steps | Returns `EMPTY_SCOPE` if no diff, `COULD_NOT_REVIEW` if unassessable | `src/bridge.mjs:268`, `src/lib/git.mjs:86` |
| 3 | Transfer | `handoff` | Transfer conversation context from host agent to target | `--from-host claude\|codex\|grok\|agy`, `[--source <path>]`, `--prompt <task>` | Transferred context digest + delegation result | Rejects sources outside host transcript directory; throws if unresolvable | `src/lib/transfer.mjs:131`, `src/bridge.mjs:275` |
| 4 | Session | `resume` | Resume existing provider session | `--session <nativeId>`, `--prompt <follow-up>` | Follow-up execution result | Throws if `--session` missing or provider lacks resume capability | `src/bridge.mjs:269` |
| 5 | Inspection | `status` | View status of a job or list jobs for repository | `[jobId]`, `[--all]`, `[--reap]`, `[--format json\|markdown]` | Job JSON or Markdown table of jobs | Throws on ENOENT if invalid jobId | `src/bridge.mjs:310`, `src/lib/jobs.mjs:153` |
| 6 | Dashboard | `runs` (Required R1) | Unified multi-connector runs dashboard & live supervision | `[--all]`, `[--cwd <path>]`, `[--format json\|markdown]` | Structured Markdown dashboard / JSON list of runs | Returns empty table/list if no runs found | `ORIGINAL_REQUEST.md:15` |
| 7 | Inspection | `result` | View stored terminal result of finished job | `<jobId>`, `[--format json\|markdown]` | Result JSON or rendered Markdown | Throws if jobId missing; returns status message if not finished | `src/bridge.mjs:328` |
| 8 | Control | `cancel` | Cancel a running/queued background job | `<jobId>` | Updated job JSON with status `CANCELED` | Idempotent; terminates worker & target process tree | `src/bridge.mjs:150`, `src/lib/provider.mjs:36` |
| 9 | Maintenance | `doctor` | Audit readiness, flags, reaped jobs, and state paths | None | JSON diagnostic report | Reaps stale jobs, garbage collects isolation worktrees | `src/bridge.mjs:249`, `src/lib/setup.mjs:62` |
| 10 | Readiness | `setup` | Check target CLI installation and authentication | `[--format json\|markdown]` | Setup status JSON or rendered Markdown | Reports install hints and login remediation if missing | `src/bridge.mjs:244`, `src/lib/setup.mjs:18` |
| 11 | Metadata | `capabilities` | Output provider capabilities, scopes, effort values | None | JSON capabilities object | Static output from connector.json | `src/bridge.mjs:229` |
| 12 | Internal | `__worker` | Background detached worker process entrypoint | `--request <path>` | Executes job asynchronously | Runs `executeJob` and exits | `src/bridge.mjs:260` |
| 13 | Hook | `session-hook` | Capture transcript path on start; reap on end | `SessionStart\|SessionEnd`, stdin JSON | Writes `session/current.json` | Clamped to short timeouts (3s/5s) | `src/session-hook.mjs:37` |
| 14 | Security | Cycle Prevention | Prevent recursive delegation loops | `AGENT_CONNECTOR_CHAIN` env var | Throws error if loop detected or chain depth > 3 | Rejects before creating isolation worktree | `src/lib/provider.mjs:25` |
| 15 | Isolation | `prepareExecutionRoot` | Worktree isolation, filtered copy, or in-place | `--isolate` flag, mode | Execution CWD, strategy, cleanup callback | Denies credentials and gitignored files on copy | `src/lib/isolation.mjs:180` |

---

## 3. Edge Cases & Observed Behavior

| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | Flag parsing | `run --expect-resposne X` | Throws `Unknown option: --expect-resposne` (strict flag validation prevents silent typo bypass). |
| 2 | Flag parsing | `run --prompt --dangerously-skip-permissions is unsafe` | Correctly preserves `--dangerously-skip-permissions is unsafe` as the prompt value without mistaking it for a flag. |
| 3 | Duration | `parseDuration("0s")` | Throws `Duration must be positive: 0s`. |
| 4 | Review Scope | Dirty workspace with uncommitted changes | `resolveScope` selects `kind: "uncommitted"`, parses numstat, diffs HEAD. |
| 5 | Review Scope | Clean workspace with no commits ahead of base | Returns `kind: "uncommitted"`, `empty: true`, status becomes `EMPTY_SCOPE` (never counts as approval). |
| 6 | Isolation | `--isolate` outside git repository | Fallback to `filtered-copy`; excludes `.env`, `id_rsa`, `node_modules`, credentials. |
| 7 | Isolation | Worker crash / process killed | Next `doctor`, `SessionEnd`, or `status --reap` reaps job as `STALE`. |
| 8 | Concurrency | Parallel write to job file | `writeJsonAtomic` uses retry backoff (`WRITE_RETRY_DELAYS_MS`) against Windows `EPERM`/`EBUSY` rename locks. |
| 9 | Multi-byte UTF8 | Streaming 4000 unicode characters | `createCapture` with `StringDecoder` ensures character boundaries are preserved across chunk slices. |
| 10 | Handoff | Transcript path outside host directory (e.g. `../../etc/passwd`) | `resolveContainedPath` throws `transcripts may only be read from <root>` preventing path traversal. |

---

## 4. Logic Chain

1. **Analysis of Requirement R1 (Unified Runs Dashboard & Live Supervision)**:
   - *Observation*: `src/lib/jobs.mjs` stores jobs under `<stateRoot>/<connectorId>/jobs/<jobId>/`. `listJobs` takes a single `connectorId`.
   - *Logic*: To provide a unified runs dashboard across all connectors (`node src/bridge.mjs runs`), a new `listAllRuns` function (or extended `listJobs`) should discover all connector state folders under `stateRoot()` (e.g., `codex`, `claude`, `grok`, `agy`, `copilot`, `qwen`, `opencode`), read their `job.json` records, sort by `createdAt` descending, and filter by `repositoryRoot` when `--all` is not passed.
   - *Observation*: For running jobs, `job.json` contains `startedAt`, `createdAt`, `workerPid`, `targetPid`, `model`, but `durationMs` is null until termination. `job.json` does not store `prompt` text.
   - *Logic*:
     1. In `createJobRecord`, store `prompt` (or `promptSummary`: first 120 chars) in `job.json` alongside `promptHash`.
     2. In `listJobs` / `listAllRuns` / `status`, compute dynamic fields:
        - `liveDurationMs`: if not terminal, `Date.now() - new Date(job.startedAt || job.createdAt).getTime()`.
        - `hostPid`: display `targetPid` (CLI process) or `workerPid` (background launcher), with alive check (`processAlive(pid)`).
        - `model`: display configured model or provider default.
        - `prompt`: display prompt summary.
     3. For single-job enrichment (`status <jobId>` or `runs <jobId>`):
        - Add stdout tail (last 15 lines of `provider.stdout.ndjson`) and stderr tail (last 15 lines of `provider.stderr.log`).
     4. In `src/lib/render.mjs`:
        - Create `renderRunsTable(runs)` to output a Markdown table:
          `| connector | job | status | pid | model | duration | mode/scope | prompt |`
        - Enhance `renderResult` to display live duration, host PID, and tail logs when present.

2. **Analysis of Requirement R2 & R4 (Flagship Commands & Manifest Generation)**:
   - *Observation*: `build-plugins.mjs` currently defines `commandFiles` with only 7 commands (`review.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`). `validate-cross-host.mjs` checks `REQUIRED_COMMANDS`.
   - *Logic*:
     - Add `adversarial-review.md`, `rescue.md`, `runs.md` to `commandFiles(connector)` in `scripts/build-plugins.mjs`.
     - Update `REQUIRED_COMMANDS` in `scripts/validate-cross-host.mjs` to include them.
     - In `src/lib/args.mjs`, add `adversarial-review`, `rescue`, `runs` to `COMMANDS`, and `--focus`, `--error`, `--test` to `VALUE_FLAGS`.
     - In `src/bridge.mjs`:
       - `adversarial-review`: alias/extension to `review` with adversarial prompt template (`--focus <area>`, Red Team framing).
       - `rescue`: alias/extension to `run` in write mode (`--mode write --confirm-write`) with `--error` and `--test` parameters, recording git stash rollback.
       - `runs`: unified dashboard dispatcher.

3. **Analysis of Requirement R3 (Review Tool Unshackling & Concurrency Policy)**:
   - *Observation*: `benchmarks/parallel-policy.json` has `defaultMaxConcurrentSubagents: 1`. Requirement states `enabled: true`, `defaultMaxConcurrentSubagents: 4`.
   - *Observation*: `tests/benchmark-parallelism.test.mjs` checks `enabledByDefault: false`. When `parallel-policy.json` is updated to `enabled: true`, test assertions must align with the active policy structure.
   - *Observation*: In `src/lib/invocation.mjs`, review prompt and tool allowlists must ensure `read_file`, `list_dir`, `grep` (and equivalent tools across Claude, Codex, Grok, Antigravity, Copilot) are unblocked for context investigation while keeping mutations gated.

---

## 5. Caveats

- **External CLI Availability**: Real CLI integration tests (`npm run test:real`) require live external binaries (`codex`, `claude`, `grok`, `agy`, `gh`) with active authentications. Unit and bridge tests use `mock-provider.mjs` and isolated temp directories.
- **Windows Process Tree Termination**: On Windows, `terminateTree(pid)` utilizes `taskkill /PID <pid> /T /F`. On POSIX, it uses `process.kill(-pid, 'SIGTERM')`. Process alive check uses `process.kill(pid, 0)`.
- **NDJSON Log Parsing**: `provider.stdout.ndjson` contains NDJSON stream chunks. Tail rendering should safely extract the latest event lines without crashing if an event is partially written.

---

## 6. Conclusion & Recommendations

### Implementation Architecture Roadmap:

1. **Core Bridge & Argument Parsing (`src/lib/args.mjs`)**:
   - Register `runs`, `adversarial-review`, `rescue` in `COMMANDS`.
   - Register `focus`, `error`, `test`, `tail` in `VALUE_FLAGS`.
   - Register `runs` boolean flags if any.

2. **Job Persistence & Runs Aggregator (`src/lib/jobs.mjs`)**:
   - Update `createJobRecord`: include `prompt: request.prompt`.
   - Implement `listAllRuns({ repositoryRoot = null, all = false } = {})`:
     - Scan all connector directories under `stateRootBase` (e.g. `tmpdir()/agent-connectors/*`).
     - Load all `job.json` records.
     - Enrich each with live duration, process liveness (`processAlive`), model, prompt summary.
     - Return sorted by `createdAt` descending.
   - Implement `readTail(filePath, maxLines = 20, maxBytes = 4096)` to safely extract tail lines.

3. **Dashboard & Status Renderer (`src/lib/render.mjs`)**:
   - Implement `renderRunsDashboard(runs)`:
     ```markdown
     | connector | job | status | pid | model | duration | scope | prompt |
     | --- | --- | --- | --- | --- | --- | --- | --- |
     ```
   - Enhance `renderResult(result)` and single job status rendering to display host PID, live/final duration, model, prompt, and stdout/stderr tail snippets when available.

4. **Bridge CLI Dispatcher (`src/bridge.mjs`)**:
   - Add `runs` command handling:
     ```js
     if (command === "runs") {
       const runs = await listAllRuns({
         all: Boolean(options.all),
         repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())),
       });
       print(runs, format, renderRunsDashboard);
       return;
     }
     ```
   - Enhance `status <jobId>`: load `job.json`, enrich with live status/duration/PID, load stdout/stderr tails, and print.
   - Implement `adversarial-review` and `rescue` command flows.

5. **Tool Unshackling & Invocation (`src/lib/invocation.mjs`)**:
   - Ensure read tools (`grep`, `read_file`, `list_dir`, etc.) are explicitly allowed and instructed in review prompts.

6. **Build Scripts & Manifests (`scripts/build-plugins.mjs`, `scripts/validate-cross-host.mjs`)**:
   - Add command definition files (`adversarial-review.md`, `rescue.md`, `runs.md`) to `commandFiles()`.
   - Update `REQUIRED_COMMANDS` in `validate-cross-host.mjs`.
   - Run `node scripts/build-plugins.mjs` to propagate changes across all 7 connector packages in `/plugins/`.

7. **Parallel Policy Configuration (`benchmarks/parallel-policy.json`)**:
   - Set `"enabled": true`, `"defaultMaxConcurrentSubagents": 4`.
   - Update `tests/benchmark-parallelism.test.mjs` to match the enabled policy configuration.

---

## 7. Verification Method

To independently verify the current and future state:

1. **Run Full Test Suite with Path Configuration**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   node --test tests/unit.test.mjs
   node --test tests/bridge.test.mjs
   ```
2. **Run Validation Script**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   node scripts/validate-cross-host.mjs
   ```
3. **Rebuild Plugins**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   node scripts/build-plugins.mjs
   ```
4. **Run QA**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   npm run qa
   ```
5. **Inspect Bridge Commands**:
   ```powershell
   $env:PATH = "C:\nvm4w\nodejs;$env:PATH"
   node src/bridge.mjs help
   node src/bridge.mjs status
   node src/bridge.mjs runs
   ```
