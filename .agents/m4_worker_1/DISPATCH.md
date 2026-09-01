## 2026-08-30T17:05:07Z
You are Milestone 4 Worker (Plugin Manifests & Build Generator Specialist).
Working directory: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m4_worker_1

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. An auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your reference inputs:
- ORIGINAL_REQUEST.md: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\ORIGINAL_REQUEST.md
- PROJECT.md: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\PROJECT.md
- Survey Explorer 3 report: C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\survey_explorer_3\handoff.md

Your exclusive write ownership:
- `scripts/build-plugins.mjs`
- `scripts/validate-cross-host.mjs`
- `plugins/` directory packages

Your tasks for Milestone 4 (R4: Manifest Generation & Plugin Consistency):
1. In `scripts/build-plugins.mjs`:
   - Update `commandFiles(connector)` to generate all required command markdown files:
     - `review.md`
     - `adversarial-review.md`
     - `rescue.md`
     - `runs.md`
     - `status.md`
     - `result.md`
     - `cancel.md`
     (as well as `delegate.md`, `handoff.md`, `setup.md`)
   - Ensure each generated markdown file has valid frontmatter (`description`, `argument-hint`, `allowed-tools`, etc.), appropriate disable-model-invocation settings, and correct `${BRIDGE}` command invocation.
2. In `scripts/validate-cross-host.mjs`:
   - Update `REQUIRED_COMMANDS` to include `adversarial-review.md`, `rescue.md`, `runs.md` (and existing required command markdown files).
3. Execute the generator:
   - Run `node scripts/build-plugins.mjs` to rebuild and regenerate all 7 connector packages under `plugins/` (`codex-connector`, `claude-connector`, `agy-connector`, `grok-connector`, `copilot-connector`, `qwen-connector`, `opencode-connector`).
4. Validate cross-host parity:
   - Run `node scripts/validate-cross-host.mjs` and verify it passes with 0 errors.
5. Run full test suite:
   - Run `npm run qa` (`node scripts/validate-cross-host.mjs && node --test tests/unit.test.mjs tests/bridge.test.mjs tests/benchmark-parallelism.test.mjs`).
   - Verify 100% pass rate.
6. Write detailed completion report in `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\m4_worker_1\handoff.md`.
7. Report completion back to orchestrator via send_message.
