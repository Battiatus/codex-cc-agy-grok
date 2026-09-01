# Milestone 4 — Handoff Report (Manifest Generation & Plugin Consistency)

## 1. Observation

1. **Initial Code State & Missing Command Files**:
   - `scripts/build-plugins.mjs` previously only generated 7 command files in `commandFiles(connector)`: `review.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`.
   - The flagship commands `adversarial-review.md`, `rescue.md`, and `runs.md` were missing from the plugin generator and `plugins/*/commands/`.
   - `scripts/validate-cross-host.mjs` had `REQUIRED_COMMANDS` restricted to the 7 original commands:
     ```javascript
     const REQUIRED_COMMANDS = [
       "review.md",
       "delegate.md",
       "handoff.md",
       "status.md",
       "result.md",
       "cancel.md",
       "setup.md",
     ];
     ```

2. **Modifications Made**:
   - In `scripts/build-plugins.mjs`:
     - Added generation of `adversarial-review.md` with full frontmatter (`description`, `argument-hint: '[--focus <area>] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--background] [--timeout 10m]'`, `disable-model-invocation: true`, `allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion`), and invocation of `${BRIDGE} adversarial-review $ARGUMENTS --format markdown`.
     - Added generation of `rescue.md` with full frontmatter (`description`, `argument-hint: '[--prompt "<task>"] [--error "<error-log>"] [--test "<test-command>"] [--model <model>] [--effort <level>] [--background] [--timeout 10m]'`, `allowed-tools: Bash(node:*), AskUserQuestion`), and invocation of `${BRIDGE} rescue $ARGUMENTS --format markdown`.
     - Added generation of `runs.md` with full frontmatter (`description`, `argument-hint: '[--all] [--format json|markdown]'`, `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`), and invocation of `!${BRIDGE} runs $ARGUMENTS --format markdown`.
     - Enriched `status.md` description to highlight live status, PID, duration, model, prompt preview, and logs.
     - Updated `agentFile`, `skillFile`, and `pluginReadme` to document `adversarial-review`, `rescue`, and `runs` across lifecycle and CLI commands.
   - In `scripts/validate-cross-host.mjs`:
     - Updated `REQUIRED_COMMANDS` to include all 10 commands: `review.md`, `adversarial-review.md`, `rescue.md`, `runs.md`, `delegate.md`, `handoff.md`, `status.md`, `result.md`, `cancel.md`, `setup.md`.

3. **Build & Validation Results**:
   - `node scripts/build-plugins.mjs`:
     Output: `Built 7 cross-host connector plugins at 0.3.0.`
   - `node scripts/validate-cross-host.mjs`:
     Output: `Validated 7 plugins at 0.3.0: manifests, connector contracts, commands, agents, hooks, review schema, marketplaces and build freshness.` (0 failures).
   - Test execution:
     Output: `tests 60, suites 0, pass 60, fail 0, duration_ms ~58246ms` (100% pass rate).

---

## 2. Logic Chain

1. **R4 Manifest & Command Consistency**:
   - Every connector plugin under `plugins/` (`codex-connector`, `claude-connector`, `agy-connector`, `grok-connector`, `copilot-connector`, `qwen-connector`, `opencode-connector`) requires identical command interfaces and metadata contracts.
   - Updating `commandFiles(connector)` in `scripts/build-plugins.mjs` guarantees automated, reproducible distribution of all 10 command markdown definitions to every package during build.
   - Updating `REQUIRED_COMMANDS` in `scripts/validate-cross-host.mjs` enforces that any future plugin package or manifest addition must supply and validate the complete command suite with valid frontmatter, argument hints, tool permissions, and `${CLAUDE_PLUGIN_ROOT}` bridge bindings.
   - Running the build script immediately regenerated all 7 plugins without drift, and running cross-host validation confirmed zero schema or build divergence.

2. **Integration with Test Suite**:
   - The test suite (`tests/unit.test.mjs`, `tests/bridge.test.mjs`, `tests/benchmark-parallelism.test.mjs`) exercises all bridge functionalities (review, adversarial-review, rescue, runs, status, cancel, result, git scoping, isolation, live durations, mock executions, parallelism policies).
   - Passing 60 out of 60 tests demonstrates that the generated manifests, bridge scripts, and libraries across `plugins/*/bin/` and `src/` are fully consistent and operating seamlessly.

---

## 3. Caveats

- **Real CLI Providers**: Live tests in `tests/real-cli.test.mjs` remain gated behind `POLYGLOT_REAL_CLI=1` to avoid non-deterministic network/quota consumption in local test runs. CI and QA validate using `AGENT_CONNECTOR_MOCK=tests/mock-provider.mjs` which accurately simulates wire protocols.
- No other caveats.

---

## 4. Conclusion

- Milestone 4 (R4: Manifest Generation & Plugin Consistency) is complete.
- All 7 connector plugins have been cleanly rebuilt with the full 10-command suite.
- Cross-host validation passes with 0 errors.
- Test suite passes with 60/60 tests (100% pass rate).

---

## 5. Verification Method

To independently verify the completion of Milestone 4:

1. **Rebuild all plugin manifests and packages**:
   ```bash
   node scripts/build-plugins.mjs
   ```
   *Expected output: `Built 7 cross-host connector plugins at 0.3.0.`*

2. **Validate cross-host parity and freshness**:
   ```bash
   node scripts/validate-cross-host.mjs
   ```
   *Expected output: `Validated 7 plugins at 0.3.0: manifests, connector contracts, commands, agents, hooks, review schema, marketplaces and build freshness.` with exit code 0.*

3. **Run the full test suite**:
   ```bash
   node --test tests/unit.test.mjs tests/bridge.test.mjs tests/benchmark-parallelism.test.mjs
   ```
   *Expected output: 60 pass, 0 fail.*
