# Handoff Report: Milestone 1 Explorer 1 (Job Store & Dashboard Renderer)

## 1. Observation

### Codebase and Architecture Observations
- **`src/lib/jobs.mjs`**:
  - Line 35-39: `stateRoot(connectorId)` defines the state path per connector as `join(base, connectorId)` where `base` is `process.env.AGENT_CONNECTOR_HOME || join(tmpdir(), "agent-connectors")`. There is currently no `stateRootBase()` helper or cross-connector aggregation function.
  - Line 101-109: `processAlive(pid)` is an unexported private helper checking `process.kill(pid, 0)` with `EPERM` catch.
  - Line 153-173: `listJobs(connectorId, { all, repositoryRoot })` only queries jobs within a single connector's directory (`stateRoot(connectorId)/jobs`).
  - No `listAllRuns` or `readJobTails` function currently exists in `src/lib/jobs.mjs`.
  
- **`src/bridge.mjs`**:
  - Line 6: Imports `COMMANDS` from `./lib/args.mjs` which does not include `"runs"`.
  - Line 103-130: `createJobRecord(config, request)` writes `job.json` with `promptHash` and `promptLength`, but **omits `prompt`** (the actual prompt string is only written to `request.json`).
  - Line 310-326: `status` command handler returns raw `job.json` for a single job or `listJobs(config.id, ...)` for multiple jobs. It does not enrich the live job with live duration, process liveness check, model, or stdout/stderr tail logs.
  
- **`src/lib/render.mjs`**:
  - Line 36-124: `renderResult(result)` formats job results. It formats `durationMs` if present, but does not display `liveDurationMs`, active `hostPid`, `model`, `prompt`, or tail logs when supervising running or recent jobs.
  - Line 126-140: `renderJobTable(jobs)` renders `| job | status | verdict | mode | scope | duration | created |`.
  - There is currently **no `renderRunsDashboard(runs)`** function implemented.
  
- **`src/lib/args.mjs`**:
  - Line 37-50: `COMMANDS` set contains `["__worker", "cancel", "capabilities", "doctor", "handoff", "help", "result", "resume", "review", "run", "setup", "status"]`. `"runs"` is absent.

- **`PROJECT.md` & `ORIGINAL_REQUEST.md` Contract Specifications**:
  - `PROJECT.md` Lines 43-46 specifies Interface Contract:
    - `listAllRuns({ repositoryRoot, all })`: returns `Array<JobRecord>` sorted by `createdAt` desc, with `liveDurationMs`, `hostPid`, `model`, `promptSummary`.
    - `readJobTails(connectorId, jobId, lines)`: returns `{ stdoutTail: string, stderrTail: string }`.
    - `renderRunsDashboard(jobs)`: renders Markdown table `| connector | job | status | pid | model | duration | scope | prompt |`.
  - `ORIGINAL_REQUEST.md` §R1 & Acceptance Criteria 3:
    - Unified runs dashboard command `runs` displaying Markdown table.
    - Enriched `/status` with status, host PID, live/final duration, model, prompt preview, stdout/stderr tails.

---

## 2. Logic Chain

1. **Storage Parity (`job.json` storing `prompt`)**:
   - *Observation*: `createJobRecord` in `bridge.mjs` (line 106) writes `promptHash` and `promptLength` to `job.json`, while the full prompt is only saved in `request.json`.
   - *Reasoning*: To efficiently render dashboards and status across hundreds of jobs without performing secondary I/O reads of `request.json` for every row, `job.json` must store `prompt: request.prompt`. For legacy records where `job.prompt` may be absent, a fallback to reading `request.json` or displaying `"—"` guarantees backward compatibility.

2. **Cross-Connector Discovery (`stateRootBase` & `listAllRuns`)**:
   - *Observation*: Connectors (`codex`, `claude`, `grok`, `agy`, `copilot`, `qwen`, `opencode`) write their state to `<stateRootBase>/<connectorId>/jobs/<jobId>/`.
   - *Reasoning*: Implementing `stateRootBase()` allows scanning all subdirectories in the state root. `listAllRuns({ repositoryRoot, all, limit })` will:
     1. Read all connector directories in `stateRootBase()`.
     2. Collect all job records across all connector `/jobs/` folders.
     3. Decorate each record with computed live fields (`liveDurationMs`, `hostPid`, `processAlive`, `model`, `promptSummary`).
     4. Filter by `repositoryRoot` when `!all` (matching jobs where `!job.repositoryRoot || job.repositoryRoot === repositoryRoot`).
     5. Sort chronologically by `createdAt` descending.
     6. Slice to `limit` (default 25) when `!all`.

3. **Live Process Supervision & Metrics Calculation**:
   - *Observation*: Jobs in status `RUNNING` or `QUEUED` have `startedAt` (or `createdAt`), `workerPid`, and `targetPid`.
   - *Reasoning*:
     - `liveDurationMs`: For completed jobs, use `job.durationMs` (or difference between `finishedAt` and `startedAt`/`createdAt`). For active jobs, compute `Date.now() - new Date(job.startedAt || job.createdAt).getTime()`.
     - `hostPid`: Evaluate `job.targetPid || job.workerPid || null`.
     - `processAlive(pid)`: Exported from `jobs.mjs` using `process.kill(pid, 0)` with `EPERM` tolerance.
     - `promptSummary`: Clean single-line snippet of `job.prompt` (newlines replaced by spaces, truncated to ~50-60 characters).

4. **Log Tail Retrieval (`readJobTails`)**:
   - *Observation*: Providers write stdout to `paths.stdout` (`provider.stdout.ndjson`) and stderr to `paths.stderr` (`provider.stderr.log`).
   - *Reasoning*: `readJobTails(connectorId, jobId, { lines = 20 } = {})` reads the tail end of both files using a byte-budget read (e.g. last 64KB), splits into lines, and returns `{ stdoutTail, stderrTail }`. If files are absent, it safely returns `{ stdoutTail: "", stderrTail: "" }`.

5. **Markdown Dashboard Rendering (`renderRunsDashboard`)**:
   - *Observation*: Contract requires Markdown table: `| connector | job | status | pid | model | duration | scope | prompt |`.
   - *Reasoning*:
     - Table header:
       `| connector | job | status | pid | model | duration | scope | prompt |`
       `| --- | --- | --- | --- | --- | --- | --- | --- |`
     - Rows format `connector`, backticked `jobId`, `status`, `pid` (or `—`), `model` (or `—`), formatted duration (`formatDuration(job.liveDurationMs ?? job.durationMs)`), `scopeKind` (or `—`), and escaped/sanitized `prompt` snippet.
     - Empty state returns `"No runs recorded."` or `"No runs recorded for this repository."`.

6. **Status Command Enrichment**:
   - *Observation*: Currently, `status <job-id>` dumps raw `job.json` without log tails or live duration.
   - *Reasoning*: When `status <job-id>` is invoked, the bridge decorates the job record with `liveDurationMs`, `hostPid`, `processAlive`, and log tails from `readJobTails`. `renderResult` formats these fields cleanly, including a log tail section if stderr/stdout logs are present.

---

## 3. Detailed Implementation Specifications & Proposed Code

### A. `src/lib/jobs.mjs` Modifications

```javascript
// Add stateRootBase
export function stateRootBase() {
  const configured = process.env.AGENT_CONNECTOR_HOME;
  return configured ? resolve(configured) : join(tmpdir(), "agent-connectors");
}

export function stateRoot(connectorId) {
  return join(stateRootBase(), connectorId);
}

// Export processAlive
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Job decoration helper
export function decorateJob(job) {
  if (!job) return null;
  const started = job.startedAt || job.createdAt;
  let liveDurationMs = job.durationMs ?? null;
  if (liveDurationMs === null && started) {
    const end = job.finishedAt ? new Date(job.finishedAt).getTime() : Date.now();
    liveDurationMs = Math.max(0, end - new Date(started).getTime());
  }

  const hostPid = job.targetPid || job.workerPid || null;
  const isTargetAlive = processAlive(job.targetPid);
  const isWorkerAlive = processAlive(job.workerPid);
  const isAlive = isTargetAlive || isWorkerAlive;

  const promptText = job.prompt || "";
  const promptSummary = promptText
    ? promptText.replace(/[\r\n\t]+/g, " ").trim()
    : null;

  return {
    ...job,
    liveDurationMs,
    hostPid,
    targetAlive: isTargetAlive,
    workerAlive: isWorkerAlive,
    processAlive: isAlive,
    model: job.model || null,
    promptSummary: promptSummary && promptSummary.length > 60
      ? `${promptSummary.slice(0, 57)}...`
      : promptSummary,
  };
}

// Read log tails
export async function readJobTails(connectorId, jobId, { lines = 20, maxBytes = 65536 } = {}) {
  const paths = jobPaths(connectorId, jobId);
  
  async function tailFile(filePath) {
    try {
      const buffer = await readFile(filePath);
      const text = buffer.length > maxBytes
        ? buffer.subarray(buffer.length - maxBytes).toString("utf8")
        : buffer.toString("utf8");
      const splitLines = text.split(/\r?\n/).filter(Boolean);
      return splitLines.slice(-lines).join("\n");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  const [stdoutTail, stderrTail] = await Promise.all([
    tailFile(paths.stdout),
    tailFile(paths.stderr),
  ]);

  return { stdoutTail, stderrTail };
}

// Multi-connector listAllRuns
export async function listAllRuns({ all = false, repositoryRoot = null, limit = MAX_LISTED_JOBS } = {}) {
  const base = stateRootBase();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const connectorDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const allJobs = [];

  for (const connectorId of connectorDirs) {
    const jobsDir = join(base, connectorId, "jobs");
    let jobIds;
    try {
      jobIds = await readdir(jobsDir);
    } catch {
      continue;
    }

    for (const jobId of jobIds) {
      const job = await readJsonOrNull(jobPaths(connectorId, jobId).job);
      if (job) {
        allJobs.push(decorateJob({ ...job, connector: job.connector || connectorId }));
      }
    }
  }

  const scoped = repositoryRoot
    ? allJobs.filter((job) => !job.repositoryRoot || job.repositoryRoot === repositoryRoot)
    : allJobs;

  const sorted = scoped.sort((left, right) =>
    String(right.createdAt).localeCompare(String(left.createdAt)));

  return all ? sorted : sorted.slice(0, limit);
}
```

### B. `src/lib/render.mjs` Modifications

```javascript
// Render runs dashboard
export function renderRunsDashboard(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return "No runs recorded for this repository.";
  }

  const header = "| connector | job | status | pid | model | duration | scope | prompt |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";

  const rows = runs.map((job) => {
    const duration = formatDuration(job.liveDurationMs ?? job.durationMs) || "—";
    const pid = job.hostPid ? String(job.hostPid) : "—";
    const model = job.model || "—";
    const scope = job.scopeKind || job.mode || "—";
    const promptPreview = (job.promptSummary || job.prompt || "—")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
    const truncatedPrompt = promptPreview.length > 50
      ? `${promptPreview.slice(0, 47)}...`
      : promptPreview;

    return `| ${[
      job.connector || "—",
      `\`${job.jobId}\``,
      job.status || "—",
      pid,
      model,
      duration,
      scope,
      truncatedPrompt || "—",
    ].join(" | ")} |`;
  });

  return [header, divider, ...rows].join("\n");
}

// In renderResult(result):
// Format model, live duration, hostPid, prompt and log tails
```

### C. `src/bridge.mjs` Modifications
- Store prompt in `createJobRecord`:
```javascript
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
    prompt: request.prompt, // <--- ADDED
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

- Handle `runs` command in `main()`:
```javascript
  if (command === "runs") {
    const repoRoot = options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd()));
    const runs = await listAllRuns({
      repositoryRoot: repoRoot,
      all: Boolean(options.all),
    });
    print(runs, format, renderRunsDashboard);
    return;
  }
```

- Enrich `status <job-id>` in `main()`:
```javascript
  if (command === "status") {
    if (options.reap) await reapStaleJobs(config.id);
    const jobId = options._[0];
    if (jobId) {
      const job = await readJson(jobPaths(config.id, jobId).job);
      const decorated = decorateJob(job);
      const tails = await readJobTails(config.id, jobId);
      print({ ...decorated, ...tails }, format, renderResult);
      return;
    }
    const jobs = await listJobs(config.id, {
      all: Boolean(options.all),
      repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())),
    });
    print(jobs.map(decorateJob), format, renderJobTable);
    return;
  }
```

---

## 4. Caveats

1. **Active Process Inspection on Windows vs Linux/macOS**:
   - `process.kill(pid, 0)` does not terminate the process; it only tests existence. On Windows, Node.js throws `EPERM` if the process exists but is owned by another user/elevated context, which indicates the process is alive.
2. **NDJSON vs Raw Text in `readJobTails`**:
   - Stdout is stored as `.ndjson` while stderr is `.log`. `readJobTails` extracts the raw last N lines. When displayed, this is raw text or event lines.
3. **Repository Scoping (`repositoryRoot`)**:
   - If a job was executed outside a Git repository, `job.repositoryRoot` is `null`. Scoping filter `!job.repositoryRoot || job.repositoryRoot === repositoryRoot` ensures jobs in the current Git repo or workspace are visible.
4. **No Direct Source Changes Rule**:
   - As an Explorer agent, source code has not been directly edited in `src/` or `plugins/`. All code changes and plans are documented here for implementation by the builder/implementer.

---

## 5. Conclusion

Milestone 1 (R1: Unified Runs Dashboard & Live Supervision) is fully scoped and architected:
1. `src/lib/jobs.mjs` will export `stateRootBase()`, `processAlive()`, `decorateJob()`, `readJobTails()`, and `listAllRuns()`.
2. `src/lib/render.mjs` will export `renderRunsDashboard()` formatting the specified Markdown table `| connector | job | status | pid | model | duration | scope | prompt |`, and enrich `renderResult` with live supervision metadata.
3. `src/bridge.mjs` and `src/lib/args.mjs` will support `runs` command and store `prompt` in `job.json`.
4. All existing contracts, schemas, and test harnesses are preserved.

---

## 6. Verification Method

To verify the implementation once applied:

1. **Unit Tests**:
   Execute Node test runner:
   ```bash
   node --test tests/unit.test.mjs
   ```
   Verify new tests:
   - `listAllRuns discovers jobs across multiple connector folders and respects repositoryRoot scoping`
   - `readJobTails extracts last N lines from stdout/stderr or returns empty strings on missing files`
   - `renderRunsDashboard renders the exact markdown table format with headers and formatted durations`
   - `processAlive correctly detects running process and handles dead PIDs`

2. **Bridge Integration Tests**:
   ```bash
   node --test tests/bridge.test.mjs
   ```
   Verify bridge commands:
   - `node src/bridge.mjs runs --format markdown` returns the runs dashboard table.
   - `node src/bridge.mjs status <job-id>` returns enriched status with live duration and tails.

3. **Build and Validation Freshness**:
   ```bash
   node scripts/build-plugins.mjs
   node scripts/validate-cross-host.mjs
   ```
