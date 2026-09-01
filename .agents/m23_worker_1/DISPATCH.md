## 2026-08-30T16:59:29Z

You are Milestone 2 & 3 Worker (Flagship Commands & Tool Unblocking Implementer).
Working directory: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m23_worker_1

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your reference inputs:
- ORIGINAL_REQUEST.md: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\ORIGINAL_REQUEST.md
- PROJECT.md: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\PROJECT.md
- Survey Explorer 2 report: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\survey_explorer_2\handoff.md
- Survey Explorer 3 report: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\survey_explorer_3\handoff.md

Your exclusive write ownership:
- `src/bridge.mjs`
- `src/lib/invocation.mjs`
- `benchmarks/parallel-policy.json`
- `tests/benchmark-parallelism.test.mjs`
- `tests/unit.test.mjs`
- `tests/bridge.test.mjs`

Your tasks:
1. Implement Milestone 2 (R2: Flagship Commands Parity):
   - In `src/bridge.mjs`:
     - Implement `command === "adversarial-review"`:
       - Run in `review` mode (read-only), with `review` schema.
       - Use `--focus` option (defaulting to "security, edge cases, vulnerability analysis, race conditions, failure modes").
       - Compose Red Team prompt emphasizing the focus area, security vulnerabilities, edge cases, and exploit vectors.
       - Normalize request, execute foreground or background (`--background`), and format output.
     - Implement `command === "rescue"`:
       - Run in `write` mode (`options.mode = "write"`, `options["confirm-write"] = true`).
       - Accept `--error` (error trace/log), `--test` (failing test command), and `--prompt` (task description).
       - Compose targeted rescue prompt incorporating error logs and test commands.
       - Ensure `rollbackRef` is captured via `stashCreate` in `provider.mjs` and returned in the result.
       - Execute foreground or background, and format output.
     - Update `helpText` to document `adversarial-review` and `rescue`.

2. Implement Milestone 3 (R3: Tool Unblocking & Concurrency):
   - In `src/lib/invocation.mjs`:
     - Update `composePrompt` in `mode === "review"` to explicitly allow read-only exploration tools (`read_file`, `list_dir`, `grep` / `Read`, `Glob`, `Grep`) to inspect repository context while strictly forbidding write/create/delete mutations.
   - In `benchmarks/parallel-policy.json`:
     - Set `"enabled": true`
     - Set `"defaultMaxConcurrentSubagents": 4`
   - In `tests/benchmark-parallelism.test.mjs`:
     - Update line 35 assertion to expect `assert.equal(report.policy.enabledByDefault, true)`.

3. Implement comprehensive unit & bridge tests:
   - In `tests/unit.test.mjs`:
     - Unit test for `composePrompt` in review mode confirming read tools are authorized and not forbidden.
   - In `tests/bridge.test.mjs`:
     - Integration test for `adversarial-review` verifying Red Team prompt generation with `--focus "security"`, schema validation, and review verdict.
     - Integration test for `rescue` verifying write mode execution, `--error` and `--test` context propagation, and `rollbackRef` presence.
     - Parity verification across primary connectors (`codex`, `claude`, `grok`, `agy`, `copilot`).

4. Execute test suite:
   - Run `node --test tests/unit.test.mjs tests/bridge.test.mjs tests/benchmark-parallelism.test.mjs`
   - Verify 100% pass rate with 0 failures.

5. Write detailed completion report in `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m23_worker_1\handoff.md`.
6. Report completion back to orchestrator via send_message.
