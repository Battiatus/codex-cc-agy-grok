# Milestone 1 — QA & Test Specification Report (Explorer 3)

**Author**: Milestone 1 Explorer 3 (QA & Test Specification Specialist)  
**Date**: 2026-08-30  
**Scope**: Milestone 1 (R1: Unified Runs Dashboard & Live Supervision)  
**Target Files for Testing**: `tests/unit.test.mjs`, `tests/bridge.test.mjs`  
**Target Files for Implementation**: `src/lib/jobs.mjs`, `src/lib/render.mjs`, `src/lib/args.mjs`, `src/bridge.mjs`

---

## 1. Observation

Direct observations from codebase inspection across `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok`:

### 1.1 Existing Test Suite Structure
- **`tests/unit.test.mjs`** (lines 1–477):
  - Uses `node:test` and `node:assert/strict`.
  - Helpers include `scratch(name)` creating temporary dirs with `mkdtemp(join(tmpdir(), "polyglot-..."))`, `git(cwd, args)` spawning git commands, and `repositoryWithChange()`.
  - Tests 20 unit scenarios across args parsing, duration parsing, schema validation, output capture, provider envelope parsing, argument building, git scope resolution, isolation strategies, credential detection, prompt composition, executable resolution, and markdown rendering.
  - Currently missing unit tests for:
    - Multi-connector job aggregation (`listAllRuns`).
    - Log tail extraction from `provider.stdout.ndjson` and `provider.stderr.log` (`readJobTails` / `readTail`).
    - Markdown runs dashboard rendering (`renderRunsDashboard`).
    - Dynamic host PID resolution (`processAlive`) and live duration computation.

- **`tests/bridge.test.mjs`** (lines 1–392):
  - Spawns `plugins/<connector>-connector/bin/agent-bridge.mjs` via `runBridge(connector, args, { env, home })`.
  - Injects `AGENT_CONNECTOR_MOCK: tests/mock-provider.mjs` and isolated `AGENT_CONNECTOR_HOME: stateHome`.
  - Tests 22 integration scenarios for `review`, `run`, `resume`, `cancel`, `status`, `setup`, `doctor`, cycle prevention, and chain limits.
  - Existing `status` test (line 267): tests single connector status with `--cwd` filter and `format: markdown` table (`| job | status | verdict | mode | scope | duration | created |`).
  - Currently missing bridge tests for:
    - `node src/bridge.mjs runs` (cross-connector markdown table and JSON output).
    - `node src/bridge.mjs runs --all` vs repository-scoped `runs --cwd <repo>`.
    - `node src/bridge.mjs status <jobId>` showing enriched PID, live/final duration, model, prompt, and log tails (`stdoutTail`, `stderrTail`).

### 1.2 Existing Source Code & Architecture
- **`src/lib/args.mjs`** (lines 37–50):
  - `COMMANDS` declaration:
    ```js
    export const COMMANDS = new Set([
      "__worker", "cancel", "capabilities", "doctor", "handoff",
      "help", "result", "resume", "review", "run", "setup", "status",
    ]);
    ```
    `runs` is not yet registered in `COMMANDS`.
  - `VALUE_FLAGS` has `format`, `cwd`, `timeout`, etc., but lacks `lines` or `tail` if needed for tail customization.
  - `BOOLEAN_FLAGS` has `all`, `background`, `confirm-write`, `help`, `isolate`, `json`, `reap`.

- **`src/lib/jobs.mjs`** (lines 35–53, 153–174):
  - `stateRoot(connectorId)` resolves to `join(base, connectorId)` where `base` is `process.env.AGENT_CONNECTOR_HOME` or `join(tmpdir(), "agent-connectors")`.
  - `jobPaths(connectorId, jobId)` creates paths for `job.json`, `request.json`, `result.json`, `provider.stdout.ndjson`, `provider.stderr.log`, `provider.final.txt`, `output-schema.json`.
  - `listJobs(connectorId, { all, repositoryRoot })` only queries `<stateRoot(connectorId)>/jobs`.
  - `createJobRecord` in `src/bridge.mjs` (lines 103–130) writes `promptHash` and `promptLength`, but omitted `prompt` text, meaning background jobs lose prompt information once `request.json` is consumed by `__worker`.

- **`src/lib/render.mjs`** (lines 126–140):
  - `renderJobTable(jobs)` renders single-connector table:
    `| job | status | verdict | mode | scope | duration | created |`
  - No `renderRunsDashboard(jobs)` table exists yet.
  - `formatDuration(durationMs)` outputs `—` when `durationMs` is null (e.g. for `RUNNING` or `QUEUED` jobs).

- **`src/bridge.mjs`** (lines 310–326):
  - `status` command:
    - If `jobId` is passed, prints `readJson(jobPaths(config.id, jobId).job)` with `renderResult`.
    - If no `jobId`, prints `listJobs(...)` with `renderJobTable`.
  - No handler exists for `command === "runs"`.

---

## 2. Logic Chain

1. **Test-Driven Design for `listAllRuns`**:
   - *Premise*: Users need to supervise all agent activities across all 5+ connectors (`codex`, `claude`, `grok`, `agy`, `copilot`, `qwen`, `opencode`) from a single command.
   - *Requirement*: `listAllRuns({ repositoryRoot = null, all = false, stateHome = null })` must:
     - Scan all connector subdirectories under `stateBase`.
     - Collect and parse `job.json` records from every connector's `jobs/` directory.
     - Enrich each record with:
       - `liveDurationMs`: dynamically calculated as `Date.now() - new Date(job.startedAt || job.createdAt)` if the job is active (`RUNNING` or `QUEUED`), or stored `durationMs` / `finishedAt - startedAt` if terminal.
       - `hostPid`: active `targetPid` or `workerPid` verified via `processAlive(pid)`, or `null` if dead/terminal.
       - `promptSummary`: sanitized, single-line preview of `job.prompt` (up to 60 chars).
       - `model`: model string or `—`.
     - Filter by `repositoryRoot` when `all` is false; include all repositories when `all` is true.
     - Sort by `createdAt` descending.
     - Truncate to `MAX_LISTED_JOBS` (25) unless `all` is true.
   - *QA Validation*: Must be tested with multi-connector mock directories, mixed repository roots, missing directories, malformed JSON files, and pagination boundaries.

2. **Test-Driven Design for `readJobTails`**:
   - *Premise*: Supervision requires observing the latest output streams of active and completed jobs without loading entire multi-megabyte log files into memory.
   - *Requirement*: `readJobTails(connectorId, jobId, { lines = 15, maxBytes = 8192 } = {})` must:
     - Read the tail of `jobPaths(connectorId, jobId).stdout` (`provider.stdout.ndjson`).
     - Read the tail of `jobPaths(connectorId, jobId).stderr` (`provider.stderr.log`).
     - Return `{ stdoutTail: string, stderrTail: string }`.
     - Return empty strings if files do not exist (`ENOENT`) or are 0 bytes.
     - Safely decode multi-byte UTF-8 characters without splitting runes.
   - *QA Validation*: Must be tested with large files (>1000 lines), short files (<5 lines), missing files, empty files, and UTF-8 multi-byte content.

3. **Test-Driven Design for `renderRunsDashboard`**:
   - *Premise*: `node src/bridge.mjs runs` outputs a formatted Markdown table per `PROJECT.md § Interface Contracts`.
   - *Specification*:
     ```markdown
     | connector | job | status | pid | model | duration | scope | prompt |
     | --- | --- | --- | --- | --- | --- | --- | --- |
     ```
   - *Rendering Rules*:
     - Column 1 (`connector`): connector ID (`codex`, `claude`, etc.).
     - Column 2 (`job`): backtick-wrapped jobId: `` `codex-12345-abcd` ``.
     - Column 3 (`status`): uppercase status string.
     - Column 4 (`pid`): host PID or `—`.
     - Column 5 (`model`): model name or `—`.
     - Column 6 (`duration`): formatted duration (e.g. `12.5s`, `450ms`, `5.2s (live)`).
     - Column 7 (`scope`): `mode` + `scopeKind` (e.g. `review/uncommitted`, `write`, `review/branch`).
     - Column 8 (`prompt`): sanitized single-line prompt snippet; pipes `|` escaped or replaced; newlines removed; truncated with `...` if exceeding 45 characters.
     - Empty List: returns `"No runs recorded across connectors."`.
   - *QA Validation*: Must assert exact header, column count, delimiter row, PID display, prompt escaping, and empty state message.

4. **Test-Driven Design for CLI Commands (`bridge.test.mjs`)**:
   - *`node src/bridge.mjs runs`*:
     - Markdown output: verify presence of table headers and aggregated rows from multiple connectors.
     - JSON output (`--format json`): verify JSON array containing enriched objects with `connector`, `jobId`, `status`, `hostPid`, `liveDurationMs`, `prompt`.
     - Scoping: verify filtering by `--cwd` and bypass with `--all`.
   - *`node src/bridge.mjs status <jobId>`*:
     - Verify enrichment with host PID, duration, model, prompt, and log tails (`stdoutTail`, `stderrTail`).
     - Test both Markdown and JSON output formats.
     - Test non-existent `jobId` error handling.

---

## 3. Caveats

1. **Windows Process Tree & Liveness**:
   - `processAlive(pid)` uses `process.kill(pid, 0)` which can throw `EPERM` on Windows if the target belongs to another security context. `EPERM` must be treated as `true` (process exists).
   - Mock tests should use `process.pid` for live process assertions and `999_999_999` for dead process assertions.
2. **Atomic Writes & File System Locks**:
   - Windows file locking during concurrent reads/writes of `job.json` and log files requires atomic write retries (`writeJsonAtomic`) and safe read handlers (`readJsonOrNull`).
3. **Log Tail Stream Bounds**:
   - `provider.stdout.ndjson` lines can be very long. `readTail` should bound both line count (`lines: 15`) and maximum byte slice (`maxBytes: 8192`) to prevent memory spikes.

---

## 4. Conclusion & Test Specification Matrix

### 4.1 Specification Matrix: Features Discovered & Tested

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Test File |
|---|----------|---------|-------------|--------|---------|----------------|-----------|
| 1 | Store | `listAllRuns` | Aggregate runs across all connector state directories | `{ repositoryRoot, all, stateHome }` | `Array<EnrichedJob>` sorted by `createdAt` desc | Returns `[]` if state directory missing or empty | `tests/unit.test.mjs` |
| 2 | Store | `readJobTails` | Extract trailing lines of stdout and stderr logs | `(connectorId, jobId, { lines, maxBytes })` | `{ stdoutTail, stderrTail }` | Returns empty strings on `ENOENT` | `tests/unit.test.mjs` |
| 3 | Render | `renderRunsDashboard` | Format runs table into Markdown dashboard | `Array<EnrichedJob>` | Markdown table string | Returns "No runs recorded..." when array empty | `tests/unit.test.mjs` |
| 4 | Supervision | Dynamic Enrichment | Compute live duration and host PID | `JobRecord` | `EnrichedJob` with `hostPid`, `liveDurationMs` | Host PID is `null` if process dead | `tests/unit.test.mjs` |
| 5 | CLI | `bridge runs` (Markdown) | Unified multi-agent runs dashboard CLI | `runs [--all] [--cwd <path>]` | Formatted Markdown dashboard table | Returns empty table notice if no runs | `tests/bridge.test.mjs` |
| 6 | CLI | `bridge runs --format json` | Machine-readable multi-agent runs list | `runs --format json [--all]` | JSON array of enriched job objects | Valid JSON `[]` on empty | `tests/bridge.test.mjs` |
| 7 | CLI | `bridge status <jobId>` | Single-job enriched inspection with log tails | `status <jobId> [--format json\|markdown]` | Enriched job status + log tails | Exits with error on invalid/unknown jobId | `tests/bridge.test.mjs` |

---

### 4.2 Edge Cases Matrix

| # | Feature | Input Condition | Expected / Tested Behavior |
|---|---------|-----------------|----------------------------|
| 1 | `listAllRuns` | `stateHome` does not exist (`ENOENT`) | Returns `[]` gracefully without throwing. |
| 2 | `listAllRuns` | `job.json` contains corrupt/invalid JSON | Skips corrupt file, logs warning if verbose, returns valid jobs. |
| 3 | `listAllRuns` | Non-directory files or arbitrary folders in `stateHome` | Ignores non-directory entries and directories without `jobs/`. |
| 4 | `listAllRuns` | 35 jobs across 4 connectors, `all: false` | Returns exactly the 25 most recent jobs. |
| 5 | `readJobTails` | Log file is missing or 0 bytes | Returns `{ stdoutTail: "", stderrTail: "" }`. |
| 6 | `readJobTails` | Log file has fewer lines than requested (e.g. 2 lines vs 15 requested) | Returns all available lines intact without padding. |
| 7 | `readJobTails` | Log file contains UTF-8 multi-byte emoji/cjk characters at boundary | Preserves full characters with `StringDecoder("utf8")`. |
| 8 | `renderRunsDashboard` | Prompt contains pipe `|`, newlines `\n`, backticks `` ` `` | Sanitizes prompt into a single line with escaped/replaced pipes. |
| 9 | `renderRunsDashboard` | Empty job list `[]` | Returns `"No runs recorded across connectors."`. |
| 10 | `Dynamic Enrichment` | Job is `RUNNING` and `targetPid` is alive (`process.pid`) | `hostPid` is `process.pid`, `liveDurationMs > 0`, `isLive: true`. |
| 11 | `Dynamic Enrichment` | Job is `RUNNING` but `workerPid` & `targetPid` are dead (`999999999`) | `hostPid` is `null`. |
| 12 | `bridge runs` | Jobs exist across multiple repos; run without `--all` | Strictly filters to jobs belonging to current `--cwd` repository. |

---

### 4.3 Detailed Unit Test Implementations (`tests/unit.test.mjs`)

Below are the exact test implementations to add to `tests/unit.test.mjs`:

```javascript
// --- MILESTONE 1 (R1: UNIFIED RUNS DASHBOARD & SUPERVISION) UNIT TESTS ---

test("listAllRuns aggregates and sorts jobs across multiple connector state directories", async () => {
  const home = await scratch("runs-state");
  const connectors = ["codex", "claude", "grok", "agy", "copilot"];
  
  // Create state directory and sample jobs
  for (let i = 0; i < connectors.length; i++) {
    const connector = connectors[i];
    const jobId = `${connector}-job-${i}`;
    const jobDir = join(home, connector, "jobs", jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        bridgeVersion: "0.3.0",
        connector,
        jobId,
        status: i === 0 ? "RUNNING" : "COMPLETED",
        completed: i !== 0,
        mode: "review",
        scopeKind: "uncommitted",
        prompt: `Test prompt for ${connector}`,
        model: `${connector}-model-v1`,
        workerPid: i === 0 ? process.pid : null,
        targetPid: i === 0 ? process.pid : null,
        repositoryRoot: i % 2 === 0 ? "/repo/alpha" : "/repo/beta",
        createdAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        startedAt: new Date(Date.now() - (10 - i) * 60000).toISOString(),
        finishedAt: i !== 0 ? new Date(Date.now() - (10 - i - 1) * 60000).toISOString() : null,
        durationMs: i !== 0 ? 60000 : null,
      }, null, 2),
      "utf8",
    );
  }

  // 1. Unscoped (all: true) - returns all 5 jobs sorted by createdAt desc
  const allRuns = await listAllRuns({ all: true, stateHome: home });
  assert.equal(allRuns.length, 5);
  assert.equal(allRuns[0].connector, "copilot"); // newest
  assert.equal(allRuns[4].connector, "codex");   // oldest

  // Verify dynamic enrichment
  const runningJob = allRuns.find((j) => j.status === "RUNNING");
  assert.ok(runningJob);
  assert.equal(runningJob.hostPid, process.pid);
  assert.ok(runningJob.liveDurationMs > 0);

  // 2. Scoped by repositoryRoot
  const scopedRuns = await listAllRuns({ repositoryRoot: "/repo/alpha", all: false, stateHome: home });
  assert.equal(scopedRuns.length, 3);
  assert.ok(scopedRuns.every((j) => j.repositoryRoot === "/repo/alpha"));

  // 3. Non-existent state directory returns empty array
  const emptyRuns = await listAllRuns({ stateHome: join(home, "non-existent") });
  assert.deepEqual(emptyRuns, []);
});

test("readJobTails extracts bounded lines from stdout and stderr logs", async () => {
  const home = await scratch("tails-state");
  const jobId = "tail-test-job-1";
  const jobDir = join(home, "codex", "jobs", jobId);
  await mkdir(jobDir, { recursive: true });

  // Generate 25 lines of stdout and 20 lines of stderr
  const stdoutLines = Array.from({ length: 25 }, (_, i) => `{"event":"step","index":${i + 1}}`).join("\n") + "\n";
  const stderrLines = Array.from({ length: 20 }, (_, i) => `[LOG ${i + 1}] Debug message`).join("\n") + "\n";

  await writeFile(join(jobDir, "provider.stdout.ndjson"), stdoutLines, "utf8");
  await writeFile(join(jobDir, "provider.stderr.log"), stderrLines, "utf8");

  const tails = await readJobTails("codex", jobId, { lines: 5, stateHome: home });
  assert.equal(tails.stdoutTail.split("\n").filter(Boolean).length, 5);
  assert.equal(tails.stderrTail.split("\n").filter(Boolean).length, 5);
  assert.ok(tails.stdoutTail.includes('"index":25'));
  assert.ok(tails.stderrTail.includes("[LOG 20]"));

  // Missing files return empty strings
  const missingTails = await readJobTails("codex", "non-existent-job", { stateHome: home });
  assert.equal(missingTails.stdoutTail, "");
  assert.equal(missingTails.stderrTail, "");
});

test("renderRunsDashboard formats a valid Markdown table and sanitizes prompt previews", () => {
  const jobs = [
    {
      connector: "codex",
      jobId: "codex-12345",
      status: "RUNNING",
      hostPid: 1234,
      model: "gpt-5.4-mini",
      liveDurationMs: 45200,
      mode: "review",
      scopeKind: "uncommitted",
      prompt: "Review the authentication changes | ensure no secrets\nand check edge cases",
    },
    {
      connector: "claude",
      jobId: "claude-67890",
      status: "COMPLETED",
      hostPid: null,
      model: "claude-sonnet-5",
      durationMs: 12400,
      mode: "write",
      scopeKind: null,
      prompt: "Fix formatting in README.md",
    },
  ];

  const markdown = renderRunsDashboard(jobs);
  assert.ok(markdown.includes("| connector | job | status | pid | model | duration | scope | prompt |"));
  assert.ok(markdown.includes("| --- | --- | --- | --- | --- | --- | --- | --- |"));
  assert.ok(markdown.includes("| codex | `codex-12345` | RUNNING | 1234 | gpt-5.4-mini |"));
  assert.ok(markdown.includes("| claude | `claude-67890` | COMPLETED | — | claude-sonnet-5 |"));
  // Prompt sanitization: no raw newlines or unescaped table-breaking pipes
  assert.ok(!markdown.includes("\nand check edge cases"));
  
  // Empty state rendering
  assert.equal(renderRunsDashboard([]), "No runs recorded across connectors.");
});
```

---

### 4.4 Detailed Bridge Test Implementations (`tests/bridge.test.mjs`)

Below are the exact test implementations to add to `tests/bridge.test.mjs`:

```javascript
// --- MILESTONE 1 (R1: UNIFIED RUNS DASHBOARD & SUPERVISION) BRIDGE TESTS ---

test("unified runs dashboard aggregates background jobs across connectors in markdown and json", async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("unified-runs-state");

  // 1. Launch 2 background jobs with different connectors
  const codexRun = await runBridge(
    "codex",
    ["review", "--cwd", directory, "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "5000" } },
  );
  assert.equal(codexRun.parsed.status, "QUEUED");
  const codexJobId = codexRun.parsed.jobId;

  const grokRun = await runBridge(
    "grok",
    ["run", "--cwd", directory, "--prompt", "inspect code", "--background", "--timeout", "60s"],
    { home, env: { MOCK_DELAY_MS: "5000" } },
  );
  assert.equal(grokRun.parsed.status, "QUEUED");
  const grokJobId = grokRun.parsed.jobId;

  // 2. Query runs dashboard (default Markdown table)
  const dashboardMarkdown = await runBridge("codex", ["runs", "--cwd", directory], { home });
  assert.match(dashboardMarkdown.stdout, /\| connector \| job \| status \| pid \| model \| duration \| scope \| prompt \|/);
  assert.match(dashboardMarkdown.stdout, new RegExp(codexJobId));
  assert.match(dashboardMarkdown.stdout, new RegExp(grokJobId));

  // 3. Query runs dashboard with JSON format
  const dashboardJson = await runBridge("codex", ["runs", "--cwd", directory, "--format", "json"], { home });
  assert.ok(Array.isArray(dashboardJson.parsed));
  assert.equal(dashboardJson.parsed.length, 2);
  assert.ok(dashboardJson.parsed.some((r) => r.jobId === codexJobId && r.connector === "codex"));
  assert.ok(dashboardJson.parsed.some((r) => r.jobId === grokJobId && r.connector === "grok"));

  // 4. Test repository scoping
  const elsewhere = await scratch("empty-repo");
  const scopedAway = await runBridge("codex", ["runs", "--cwd", elsewhere, "--format", "json"], { home });
  assert.equal(scopedAway.parsed.length, 0);

  const allRuns = await runBridge("codex", ["runs", "--all", "--format", "json"], { home });
  assert.equal(allRuns.parsed.length, 2);
});

test("status command for a single job provides enriched metadata and log tails", async () => {
  const directory = await repositoryWithChange();
  const home = await scratch("status-enrich-state");

  const started = await runBridge(
    "claude",
    ["review", "--cwd", directory, "--timeout", "60s"],
    { home },
  );
  assert.equal(started.parsed.status, "COMPLETED");
  const jobId = started.parsed.jobId;

  // Query status <jobId> in JSON format
  const statusJson = await runBridge("claude", ["status", jobId, "--format", "json"], { home });
  assert.equal(statusJson.parsed.jobId, jobId);
  assert.equal(statusJson.parsed.connector, "claude");
  assert.ok(statusJson.parsed.durationMs >= 0);
  assert.ok("stdoutTail" in statusJson.parsed);
  assert.ok("stderrTail" in statusJson.parsed);

  // Query status <jobId> in Markdown format
  const statusMarkdown = await runBridge("claude", ["status", jobId, "--format", "markdown"], { home });
  assert.match(statusMarkdown.stdout, /## claude · COMPLETED/);
  assert.match(statusMarkdown.stdout, new RegExp(jobId));
});
```

---

## 5. Verification Method

To independently verify the test suite and ensure Milestone 1 functionality:

1. **Verify Unit Tests**:
   ```cmd
   set PATH=C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;%PATH%
   node --test tests/unit.test.mjs
   ```
2. **Verify Bridge Integration Tests**:
   ```cmd
   set PATH=C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;%PATH%
   node --test tests/bridge.test.mjs
   ```
3. **Verify Cross-Host Validation and Build Freshness**:
   ```cmd
   set PATH=C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;%PATH%
   node scripts/validate-cross-host.mjs
   ```
4. **Execute CLI Manual Verification**:
   ```cmd
   set PATH=C:\Users\User\AppData\Local\uv\cache\archive-v0\R11kkosVAeeGoJmR\playwright\driver;%PATH%
   node src/bridge.mjs help
   node src/bridge.mjs runs
   ```
