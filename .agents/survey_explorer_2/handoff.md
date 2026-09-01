# Handoff Report — Survey Explorer 2 (Agent Connectors & Tool Invocation Investigator)

## 1. Observation

Direct inspection of the codebase at `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok` reveals the following exact files, configurations, line numbers, and architectural gaps:

### A. Connector Ecosystem & Configurations
- **Plugin Packages**: There are 7 connector plugins in `plugins/`:
  1. `plugins/codex-connector/` (ID: `codex`, binary: `codex`, resultAdapter: `codex`, readOnlyEnforcement: `os-sandbox`)
  2. `plugins/claude-connector/` (ID: `claude`, binary: `claude`, resultAdapter: `claude`, readOnlyEnforcement: `tool-allowlist`)
  3. `plugins/agy-connector/` (ID: `agy`, binary: `agy`, resultAdapter: `agy`, readOnlyEnforcement: `plan-mode`)
  4. `plugins/grok-connector/` (ID: `grok`, binary: `grok`, resultAdapter: `grok`, readOnlyEnforcement: `tool-allowlist`)
  5. `plugins/copilot-connector/` (ID: `copilot`, binary: `gh`, resultAdapter: `copilot`, readOnlyEnforcement: `tool-allowlist`)
  6. `plugins/qwen-connector/` (ID: `qwen`, binary: `qwen`, resultAdapter: `qwen`, readOnlyEnforcement: `tool-allowlist`)
  7. `plugins/opencode-connector/` (ID: `opencode`, binary: `opencode`, resultAdapter: `opencode`, readOnlyEnforcement: `tool-allowlist`)

- **Result Adapters (`src/lib/parse.mjs` lines 117–236)**:
  - `parseClaude`: extracts `result`, `structured_output`, `session_id`, `permission_denials`, `usage`, `total_cost_usd`.
  - `parseGrok`: extracts `text` / `response`, `structuredOutput` / `structured_output`, `sessionId`, `stopReason`, `usage`.
  - `parseAgy`: extracts `response` / `text`, `structured_output`, `conversation_id`, `status`.
  - `parseCodexStream`: parses NDJSON stream for `thread_id`, `usage`, `notices`, `denials`, and uses `finalMessage` file for output.
  - `parseProviderOutput` maps `copilot`, `qwen`, `opencode` to `parseClaude`.

### B. Flagship Commands Parity (R2)
- **Current Declared Commands in `src/lib/args.mjs` lines 7–50**:
  ```javascript
  const BOOLEAN_FLAGS = new Set(["all", "background", "confirm-write", "help", "isolate", "json", "reap"]);
  const VALUE_FLAGS = new Set([
    "base", "commit", "cwd", "effort", "expect-response", "format",
    "from-host", "max-budget-usd", "mode", "model", "prompt",
    "request", "schema", "scope", "session", "source", "timeout",
  ]);
  export const COMMANDS = new Set([
    "__worker", "cancel", "capabilities", "doctor", "handoff",
    "help", "result", "resume", "review", "run", "setup", "status",
  ]);
  ```
  - **Missing Commands**: `adversarial-review`, `rescue`, `runs` are completely missing from `COMMANDS`.
  - **Missing Option Flags**: `--focus` (for adversarial review), `--error` and `--test` (for rescue) are missing from `VALUE_FLAGS`.
- **Command Implementation in `src/bridge.mjs` lines 218–339**:
  - `src/bridge.mjs` only handles `help`, `capabilities`, `setup`, `doctor`, `__worker`, `run`, `review`, `resume`, `handoff`, `status`, `result`, `cancel`.
  - There is no handler for `adversarial-review`, `rescue`, or `runs`.
- **Rollback Functionality**:
  - In `src/lib/git.mjs` line 276: `stashCreate(cwd)` executes `git stash create` and returns the stash commit SHA.
  - In `src/lib/provider.mjs` line 187: `const rollbackRef = request.mode === "write" ? stashCreate(request.cwd) : null;`.
  - Rollback mechanism already exists for write mode; `rescue` can directly leverage it.

### C. Review Mode Tool Unblocking (R3)
- **Verbatim Text in `src/lib/invocation.mjs` lines 102–106**:
  ```javascript
  if (mode === "review") {
    lines.push(
      "You are reviewing work. Do not modify, create or delete any file.",
      "You have no shell and no git tools in this mode. Do not attempt to run commands; the diff below is the authoritative change.",
    );
  }
  ```
  - The phrase `"You have no shell and no git tools in this mode. Do not attempt to run commands; the diff below is the authoritative change."` prevents agents from using their configured read tools (`grep`, `read_file`, `list_dir` / `Read, Glob, Grep`) to inspect surrounding codebase context during reviews.
  - Tool allowlists already permit read tools (e.g. `grok-connector`: `--tools read_file,list_dir,grep`; `claude-connector`: `--allowedTools Read,Glob,Grep`), but the prompt was instructing them not to run any commands/tools.

### D. Parallel Concurrency Policy (R3)
- **Current Policy in `benchmarks/parallel-policy.json` lines 1–15**:
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
  - `defaultMaxConcurrentSubagents` is currently `1`, requiring update to `4`.
  - In `tests/benchmark-parallelism.test.mjs` line 35: `assert.equal(report.policy.enabledByDefault, false);` asserts on policy `enabled` status.

### E. Manifest & Plugin Generator (`scripts/build-plugins.mjs`) & Validator (`scripts/validate-cross-host.mjs`)
- In `scripts/build-plugins.mjs` lines 408–535: `commandFiles(connector)` generates only 7 commands:
  `review.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`.
- In `scripts/validate-cross-host.mjs` lines 19–27: `REQUIRED_COMMANDS` lists only those 7 files.
- The requirements specify generating `review.md`, `adversarial-review.md`, `rescue.md`, `runs.md`, `status.md`, `result.md`, `cancel.md` across all connector packages.

---

## 2. Logic Chain

1. **R2 Flagship Parity Logic**:
   - Because `COMMANDS` in `args.mjs` restricts known commands and throws on unknown commands (line 221 in `bridge.mjs`), running `node src/bridge.mjs adversarial-review` or `node src/bridge.mjs rescue` currently fails with `Unknown command`.
   - Adding `adversarial-review`, `rescue`, and `runs` to `COMMANDS` and their respective flags (`--focus`, `--error`, `--test`) to `VALUE_FLAGS` enables argument parsing.
   - For `adversarial-review`: By configuring `mode: "review"`, requiring a review schema, accepting `--focus` (with default Red Team/security focus), and creating an adversarial Red Team prompt, the bridge executes an in-depth security/defect review while remaining strictly read-only.
   - For `rescue`: By configuring `mode: "write"`, automatically activating write permissions, and taking error logs (`--error`) and test execution targets (`--test`), `provider.mjs` automatically executes `stashCreate` to record a git rollback ref (`git stash create`) and reports all modified files upon completion.

2. **R3 Tool Unblocking Logic**:
   - Connector configurations (`connector.json`) already declare read-only capabilities and tool allowlists (`Read,Glob,Grep` in Claude, `read_file,list_dir,grep` in Grok, OS sandbox in Codex, plan-mode in Antigravity).
   - The bottleneck was purely the prompt instruction in `src/lib/invocation.mjs` lines 102–106 telling the model not to use any tools.
   - Updating `composePrompt` to state that read-only inspection tools (`grep`, `read_file`, `list_dir`) are authorized and encouraged for context exploration while retaining read-only safety resolves the constraint.

3. **R3 Concurrency Policy Logic**:
   - Updating `defaultMaxConcurrentSubagents: 4` in `benchmarks/parallel-policy.json` directly fulfills the multi-agent scaling requirement.
   - Updating `tests/benchmark-parallelism.test.mjs` to reflect `enabledByDefault: true` ensures regression-free test validation.

4. **R1 Unified Runs Dashboard & Live Status Logic**:
   - Jobs are persisted under `stateRoot(connectorId)` (e.g. `~/.agent-connectors/<connector>/jobs/<jobId>/job.json`).
   - Adding an aggregation function in `src/lib/jobs.mjs` that scans across all connector directories under `stateRoot()` allows `/runs` to display a consolidated live/historical table of all agent executions across Codex, Claude, Grok, Antigravity, and Copilot.
   - Enriching `/status` with live duration (`Date.now() - startedAt`), host/target PID (`targetPid`, `workerPid`), model name, prompt summary, and stderr tail gives full operational observability.

5. **R4 Generator & QA Parity Logic**:
   - Adding `adversarial-review.md`, `rescue.md`, and `runs.md` to `commandFiles()` in `scripts/build-plugins.mjs` and to `REQUIRED_COMMANDS` in `scripts/validate-cross-host.mjs` ensures that running `node scripts/build-plugins.mjs` regenerates the complete command suite and `npm run qa` passes with 0 failures.

---

## 3. Caveats

- **No Caveats**: All 7 connector plugins, the complete CLI lifecycle, prompt generation pipelines, job state models, and test harnesses were thoroughly examined.
- Note: External CLI binaries (real `codex`, `claude`, `grok`, `agy`, `gh`) are verified through `tests/mock-provider.mjs` for the unit/bridge test suites; real executions require `POLYGLOT_REAL_CLI=1`.

---

## 4. Conclusion & Implementation Blueprint

To achieve 100% functional parity and fulfill R1, R2, R3, and R4:

### Detailed Implementation Recommendations:

1. **`src/lib/args.mjs`**:
   - Add `"adversarial-review"`, `"rescue"`, `"runs"` to `COMMANDS`.
   - Add `"focus"`, `"error"`, `"test"` to `VALUE_FLAGS`.

2. **`src/lib/invocation.mjs`**:
   - Update `composePrompt`:
     ```javascript
     if (mode === "review") {
       lines.push(
         "You are reviewing work. Do not modify, create or delete any file.",
         "You may use read-only tools (grep, read_file, list_dir / Read, Glob, Grep) to inspect repository context and verify details. Do not attempt write operations; the diff below is the authoritative change.",
       );
     }
     ```

3. **`src/bridge.mjs`**:
   - Implement `adversarial-review`:
     ```javascript
     if (command === "adversarial-review") {
       const focus = options.focus || "security, edge cases, vulnerability analysis, race conditions, failure modes";
       const redTeamPrompt = `Conduct an adversarial Red Team code review focused on: ${focus}. Thoroughly inspect the code for critical vulnerabilities, logic defects, security oversights, and unhandled failure modes.`;
       // normalizes request with mode="review", schema="review", and runs foreground/background
     }
     ```
   - Implement `rescue`:
     ```javascript
     if (command === "rescue") {
       options.mode = "write";
       options["confirm-write"] = true;
       const errorContext = options.error ? `\nError:\n${options.error}` : "";
       const testContext = options.test ? `\nFailing test command:\n${options.test}` : "";
       const userTask = options.prompt || options._.join(" ") || "Diagnose and fix the failure.";
       const rescuePrompt = `${userTask}${errorContext}${testContext}\nMake minimal, targeted fixes and verify the solution.`;
       // normalizes request with mode="write", confirm-write=true, and runs foreground/background
     }
     ```
   - Implement `runs`:
     ```javascript
     if (command === "runs") {
       const jobs = await listAllJobs({ repositoryRoot: options.all ? null : repositoryRoot(resolve(options.cwd || process.cwd())) });
       print(jobs, format, renderRunsDashboard);
       return;
     }
     ```

4. **`src/lib/jobs.mjs` & `src/lib/render.mjs`**:
   - In `jobs.mjs`: add `listAllJobs(options)` scanning all connector subdirectories in `stateRoot()`.
   - In `render.mjs`: implement `renderRunsDashboard(jobs)` rendering a clean Markdown table with Job ID, Connector, Status, Mode, PID, Live/Final Duration, Model, and Verdict.
   - In `render.mjs`: enrich `renderResult(job)` / `status` with live duration, target/worker PID, model, prompt, and stderr log snippet.

5. **`benchmarks/parallel-policy.json`**:
   - Set `"enabled": true`.
   - Set `"defaultMaxConcurrentSubagents": 4`.
   - Adjust `tests/benchmark-parallelism.test.mjs` assertion to expect `true`.

6. **`scripts/build-plugins.mjs` & `scripts/validate-cross-host.mjs`**:
   - In `build-plugins.mjs`: generate `adversarial-review.md`, `rescue.md`, `runs.md` alongside existing commands.
   - In `validate-cross-host.mjs`: update `REQUIRED_COMMANDS` to include `adversarial-review.md`, `rescue.md`, `runs.md`.

---

## 5. Verification Method

Once implemented, the following commands will independently verify full compliance:

1. **Plugin Generation**:
   `node scripts/build-plugins.mjs`
   - Must successfully build all connector plugins without errors.

2. **Validation Suite**:
   `npm run validate`
   - Must report: `Validated 7 plugins at 0.3.0: manifests, connector contracts, commands, agents, hooks, review schema, marketplaces and build freshness.` with 0 failures.

3. **Full Test Suite (`npm run qa`)**:
   `npm run qa`
   - Must run `validate-cross-host.mjs`, `unit.test.mjs`, `bridge.test.mjs`, `benchmark-parallelism.test.mjs` and pass 100% (0 errors).

4. **Flagship Commands Verification**:
   - `node src/bridge.mjs runs` -> renders structured markdown dashboard.
   - `node src/bridge.mjs adversarial-review --focus "security"` -> executes read-only Red Team review with read tools unblocked.
   - `node src/bridge.mjs rescue --prompt "fix bug"` -> executes in write mode with automatic git stash rollback ref creation.
