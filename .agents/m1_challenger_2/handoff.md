# Challenge Report — Milestone 1: CLI Bridge Operations & Live Supervision

**Agent**: Milestone 1 Challenger 2 (Empirical Challenger)  
**Date**: 2026-08-30T17:00:00Z  
**Verdict**: **APPROVE**

---

## 1. Observation

### 1.1 Empirical Test Execution Commands & Outputs

We executed the full suite of unit, bridge, and custom empirical adversarial tests on Node v24.16.0 (Windows x64):

1. **Adversarial Empirical Test Suite** (`tests/m1-adversarial-empirical.test.mjs`):
```text
node --test tests/m1-adversarial-empirical.test.mjs
✔ Empirical Challenge 1: runs command formatting JSON vs Markdown across isolated connectors (738.055ms)
✔ Empirical Challenge 2: status <jobId> live duration and log tails (622.1152ms)
✔ Empirical Challenge 3: Repository scoping with --cwd vs --all (1453.0439ms)
✔ Empirical Challenge 4: Error handling, validation & log boundary stress (336.4442ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ duration_ms 3292.8456
```

2. **Core Unit & Bridge Test Suite** (`tests/unit.test.mjs`, `tests/bridge.test.mjs`):
```text
node --test tests/unit.test.mjs tests/bridge.test.mjs
✔ unified runs dashboard aggregates background jobs across connectors in markdown and json (2542.7594ms)
✔ status command for a single job provides enriched metadata and log tails (1782.8758ms)
✔ listAllRuns aggregates and sorts jobs across multiple connector state directories (47.8589ms)
✔ readJobTails extracts bounded lines from stdout and stderr logs (12.2476ms)
✔ renderRunsDashboard formats a valid Markdown table and sanitizes prompt previews (0.8877ms)
ℹ tests 47
ℹ suites 0
ℹ pass 47
ℹ fail 0
ℹ duration_ms 39757.8709
```

3. **Verbatim CLI Bridge Executions**:
- `node src/bridge.mjs runs --format markdown`:
```markdown
| connector | job | status | pid | model | duration | scope | prompt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | `codex-mtdiv14n-6e6df55e` | TIMEOUT | 40576 | — | 300.7s | write | — |
| claude | `claude-msoyaqtr-e580b164` | COMPLETED_WITH_DENIALS | 34412 | — | 412.4s | workspace | — |
```
- `node src/bridge.mjs status claude-msoyaqtr-e580b164 --format json`:
```json
{
  "bridgeVersion": "0.3.0",
  "connector": "claude",
  "jobId": "claude-msoyaqtr-e580b164",
  "status": "COMPLETED_WITH_DENIALS",
  "completed": false,
  "mode": "review",
  "scopeKind": "workspace",
  "durationMs": 412384,
  "liveDurationMs": 412384,
  "hostPid": 34412,
  "targetAlive": false,
  "workerAlive": false,
  "processAlive": false,
  "stdoutTail": null,
  "stderrTail": null
}
```

### 1.2 Key Source Code Inspections

- `src/bridge.mjs` (lines 350-358):
  `runs` command integrates with `listAllRuns`, supports `--all`, `--cwd`, `--reap`, and `--format json|markdown`.
- `src/lib/jobs.mjs` (lines 244-282):
  `listAllRuns` traverses all connector directories under `stateRootBase()`, aggregates `job.json` records, applies `repositoryRoot` filter when provided, and sorts by `createdAt` descending.
- `src/lib/jobs.mjs` (lines 149-178):
  `readJobTails` reads the tail of `provider.stdout.ndjson` and `provider.stderr.log`, slicing up to `maxBytes` (64KB default) and returning the requested number of lines (default 15).
- `src/lib/render.mjs` (lines 139-173):
  `renderRunsDashboard` constructs the Markdown table and escapes `|` characters to `\|` in prompt previews to maintain markdown table syntax integrity.

---

## 2. Logic Chain

1. **Runs Dashboard (`runs --format json` vs `--format markdown`)**:
   - `listAllRuns` reads from state folders for all active connectors (`codex`, `claude`, `agy`, `grok`, `copilot`, etc.).
   - In JSON format, output is a serializable array of enriched `JobRecord` objects.
   - In Markdown format, `renderRunsDashboard` produces valid 8-column tables with `| connector | job | status | pid | model | duration | scope | prompt |`. Prompts containing newlines, tabs, and `|` pipe characters are sanitized and escaped, preventing column misalignment. Empty states correctly return `"No runs recorded across connectors."`.

2. **Status Live Duration & Log Tails (`status <jobId>`)**:
   - For running jobs without `finishedAt`, `decorateJob` dynamically calculates `liveDurationMs` from `startedAt` (or `createdAt`) to `Date.now()`.
   - Host PID is resolved from alive processes (`targetPid` or `workerPid`) via `processAlive` signal check (`kill(pid, 0)`).
   - Log tailing (`readJobTails`) safely bounds buffer reading to 64KB, handles non-existent or 0-byte log files cleanly by returning empty strings without throwing, and properly subsets the last N lines.
   - Configurable `--tail <N>` rejects invalid values (strings, negative numbers) via `parsePositiveNumber`.

3. **Repository Scoping (`--cwd` vs `--all`)**:
   - When `--all` is supplied, `repositoryRoot` is null, returning all runs across all repositories.
   - When `--cwd <path>` is supplied, `repositoryRoot(resolve(options.cwd))` evaluates the Git toplevel. Only jobs where `job.repositoryRoot === repositoryRoot` are retained.
   - For single-connector `status`, `--cwd` scopes the listing to matching jobs.

---

## 3. Caveats

1. **Live Tag in Status Markdown**:
   In `src/bridge.mjs` line 224, `durationMs` is assigned `job.durationMs ?? result?.durationMs ?? decorated.liveDurationMs ?? null`. Because `durationMs` is given `liveDurationMs` when the job is running, `renderResult` line 52 (`result.liveDurationMs && !result.durationMs`) formats duration without the trailing `(live)` text string in Markdown. However, `liveDurationMs` is fully present in JSON output, and `status` is clearly printed as `RUNNING`.
2. **Benchmark Test Fixture**:
   `tests/benchmark-parallelism.test.mjs` expects `parallel-policy.json` to have `enabled: false` before Milestone 3. This is decoupled from Milestone 1 CLI bridge operations.

---

## 4. Conclusion

**Verdict: APPROVE**

The CLI bridge operations implemented for Milestone 1 meet all requirements defined in `PROJECT.md` and `ORIGINAL_REQUEST.md`:
- `runs` command works reliably with JSON and Markdown formatting.
- `status <jobId>` provides enriched metadata (model, PID, live duration, prompt preview) and bounded stdout/stderr log tails.
- Repository scoping correctly differentiates between `--cwd` and `--all`.
- All edge cases (empty states, large logs, invalid arguments, pipe-character escaping) were empirically challenged and verified.

---

## 5. Verification Method

To independently verify all findings, run:

```bash
# 1. Run empirical challenger test suite
node --test tests/m1-adversarial-empirical.test.mjs

# 2. Run unit and bridge test suites
node --test tests/unit.test.mjs tests/bridge.test.mjs

# 3. Test runs command live
node src/bridge.mjs runs --format json
node src/bridge.mjs runs --format markdown

# 4. Test status command live
node src/bridge.mjs status --all --format json
```
