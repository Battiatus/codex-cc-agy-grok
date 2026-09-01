# Handoff Report: Milestone 1 (Polyglot Bridge & Runs Dashboard Implementer)

## 1. Observation

Direct observations from source inspection and execution during Milestone 1 implementation:

- **`src/lib/args.mjs`**:
  - `COMMANDS` previously contained 12 commands (`__worker`, `cancel`, `capabilities`, `doctor`, `handoff`, `help`, `result`, `resume`, `review`, `run`, `setup`, `status`), omitting `runs` (as well as `adversarial-review` and `rescue`).
  - `VALUE_FLAGS` lacked `tail`, `focus`, `error`, and `test`.
  - Added `"runs"`, `"adversarial-review"`, `"rescue"` to `COMMANDS` and `"tail"`, `"focus"`, `"error"`, `"test"` to `VALUE_FLAGS`.

- **`src/lib/jobs.mjs`**:
  - Exported `stateRootBase(stateHome = null)` resolving `AGENT_CONNECTOR_HOME` or `tmpdir()/agent-connectors`.
  - Exported `processAlive(pid)` using `process.kill(pid, 0)` with safe `EPERM` error code handling.
  - Implemented `decorateJob(job)` calculating `liveDurationMs`, `hostPid`, `processAlive` (`targetAlive`, `workerAlive`), `model`, and sanitized `promptSummary` (newlines replaced, truncated to 60 chars).
  - Implemented `readJobTails(connectorId, jobId, options)` reading up to `lines` recent entries from `provider.stdout.ndjson` and `provider.stderr.log` within a byte slice budget (`maxBytes: 65536`), returning empty strings on `ENOENT`.
  - Implemented `listAllRuns({ all, repositoryRoot, limit, stateHome })` scanning all connector directories in `stateRootBase()`, collecting, decorating, filtering by `repositoryRoot`, sorting chronologically descending, and applying limit.
  - Updated `listJobs` and `reapStaleJobs` to support optional `stateHome` parameter for test isolation.

- **`src/lib/render.mjs`**:
  - Implemented `renderRunsDashboard(runs)` generating the Markdown table:
    `| connector | job | status | pid | model | duration | scope | prompt |`
    `| --- | --- | --- | --- | --- | --- | --- | --- |`
    with proper column formatting, escaping of table pipes `|`, backtick-wrapped job IDs, live/final formatted durations, and empty notice `"No runs recorded across connectors."`.
  - Enriched `renderResult(result)` to output `pid <hostPid>`, `model <model>`, `liveDurationMs` (`<duration> (live)`), `**Prompt:** <prompt>`, and fenced code blocks for `### Recent stdout` and `### Recent stderr` log tails.

- **`src/bridge.mjs`**:
  - In `createJobRecord`, added `prompt: request.prompt` so prompt text persists in `job.json` after `request.json` is unlinked.
  - Implemented `inspectJob(defaultConnectorId, jobId, { tailLines })` resolving cross-connector job paths, decorating jobs with live metrics, and reading stdout/stderr tails.
  - Added `runs` command dispatching `listAllRuns` with `renderRunsDashboard` (or JSON format).
  - Enriched `status` command: single job inspection (`status <jobId>`) invokes `inspectJob` and renders with `renderResult`.
  - Updated `helpText` to document `runs` and `--tail` on `status`.
  - Added root directory fallback in `loadConnectorConfig` resolving `plugins/codex-connector/connector.json` when `node src/bridge.mjs` is run from the workspace root.

- **Automated Tests**:
  - `tests/unit.test.mjs`: Added 3 unit tests covering `listAllRuns`, `readJobTails`, and `renderRunsDashboard`. Total: 23 unit tests, 23 passed (100%).
  - `tests/bridge.test.mjs`: Added 2 bridge integration tests covering multi-connector `runs` aggregation and enriched single-job `status <jobId>`. Total: 24 bridge tests, 24 passed (100%).
  - `scripts/validate-cross-host.mjs`: Validated 7 plugin packages at version 0.3.0 with 0 errors.

---

## 2. Logic Chain

1. **Prompt Persistence**:
   - `createJobRecord` in `src/bridge.mjs` previously wrote `promptHash` and `promptLength` while `request.json` was deleted by `__worker`. Adding `prompt: request.prompt` directly to `job.json` preserves the prompt text permanently.
   - `decorateJob` extracts `prompt` and produces `promptSummary` for single-line display across dashboard tables.

2. **Cross-Connector Multi-Agent Supervision**:
   - `stateRootBase()` identifies the root containing connector directories (`codex`, `claude`, `grok`, `agy`, `copilot`, `qwen`, `opencode`).
   - `listAllRuns` aggregates across all subdirectories under `<stateRootBase>/*/jobs/*`, decorates each record with process liveness and live duration, filters by `repositoryRoot`, and sorts newest first.
   - `renderRunsDashboard` transforms these aggregated records into the Markdown table required by `PROJECT.md § Interface Contracts`.

3. **Live Job Supervision & Status Enrichment**:
   - For active jobs (`QUEUED` or `RUNNING`), `decorateJob` computes `liveDurationMs = Date.now() - startedAt` and verifies `processAlive(targetPid)` / `processAlive(workerPid)`.
   - `readJobTails` extracts the trailing lines of stdout and stderr streams without buffering entire files.
   - `renderResult` formats `status <jobId>` with live duration indicator (`X.Xs (live)`), active host PID, model, prompt preview, and fenced stdout/stderr log blocks.

---

## 3. Caveats

- **Process Inspection on Windows**:
  - `processAlive(pid)` uses `process.kill(pid, 0)`. On Windows, elevated or different-user processes throw `EPERM` when alive, which is safely handled and interpreted as `true`.
- **Repository Scoping Filter**:
  - When `runs` or `status` is executed with `--cwd <path>` without `--all`, filtering uses exact match on `job.repositoryRoot === repositoryRoot`. Non-git jobs or foreign repositories are omitted from the scoped view.
- **Legacy Job Records**:
  - Jobs created prior to M1 without `job.prompt` display `—` in the prompt column of `runs` without throwing exceptions.

---

## 4. Conclusion

Milestone 1 (R1: Unified Runs Dashboard & Live Supervision) is 100% implemented, verified, and passing all tests:
- `node src/bridge.mjs runs` outputs the structured multi-agent dashboard table across all connectors.
- `node src/bridge.mjs status <jobId>` returns enriched live status with host PID, live duration, model, prompt, and log tails.
- All 23 unit tests in `tests/unit.test.mjs` pass.
- All 24 bridge integration tests in `tests/bridge.test.mjs` pass.
- All plugin packages are built and cross-host validated.

---

## 5. Verification Method

To independently verify the implementation:

1. **Run Unit Tests**:
   ```powershell
   $env:PATH = "C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;$env:PATH"
   node --test tests/unit.test.mjs
   ```
   Expected: 23 passed, 0 failed.

2. **Run Bridge Integration Tests**:
   ```powershell
   $env:PATH = "C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;$env:PATH"
   node --test tests/bridge.test.mjs
   ```
   Expected: 24 passed, 0 failed.

3. **Run Cross-Host Validation**:
   ```powershell
   $env:PATH = "C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;$env:PATH"
   node scripts/validate-cross-host.mjs
   ```
   Expected: `Validated 7 plugins at 0.3.0`.

4. **Verify Manual CLI Commands**:
   ```powershell
   $env:PATH = "C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;$env:PATH"
   node src/bridge.mjs help
   node src/bridge.mjs runs --format markdown
   ```
