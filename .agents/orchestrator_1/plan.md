# Implementation & Orchestration Plan: codex-cc-agy-grok Modernization

## Overview
Modernize the multi-agent polyglot connector suite to achieve full feature parity with `openai/codex-plugin-cc`, unify live execution tracking (`runs`), expand symmetrical peer-to-peer architecture across 5 agents (`codex`, `claude`, `agy`, `grok`, `copilot`), unblock tool usage in review mode, update concurrency policies, and ensure automated plugin manifest generation.

## Milestones
1. **Milestone 0: Codebase Survey & Gap Analysis**
   - Survey agent CLI connectors, existing bridge architecture, tests, and plugins.
   - Investigate test harness, build scripts, parallel policy, and bridge commands.
2. **Milestone 1: Runs Dashboard & Live Supervision (R1)**
   - Implement `/runs` command in `src/bridge.mjs` and supporting modules (`src/lib/status.mjs`, `src/lib/runs.mjs`).
   - Enrich `/status` with status, host PID, live/final duration, model, prompt, tail stdout/stderr logs.
3. **Milestone 2: Flagship Commands Parity (R2)**
   - Implement `/adversarial-review` (with `--focus`) generating red team prompts across all agents.
   - Implement `/rescue` (write mode with `--error`, `--test`, and git rollback via `git stash create`).
   - Ensure symmetrical support for `codex`, `claude`, `grok`, `agy`, `copilot`.
4. **Milestone 3: Tool Unblocking & Concurrency Policy (R3)**
   - Unblock read-only review tools (`grep`, `read_file`, `list_dir`) in `src/lib/invocation.mjs`.
   - Configure `benchmarks/parallel-policy.json` (`enabled: true`, `defaultMaxConcurrentSubagents: 4`).
5. **Milestone 4: Manifest Generation & Plugin Consistency (R4)**
   - Update `scripts/build-plugins.mjs` to auto-generate `review.md`, `adversarial-review.md`, `rescue.md`, `runs.md`, `status.md`, `result.md`, `cancel.md` for all 5 packages under `plugins/`.
6. **Milestone 5: Comprehensive QA & Verification**
   - Run `npm run qa`, verify 100% pass rate.
   - Verify `node src/bridge.mjs runs`, `adversarial-review`, `rescue`.
   - Forensic integrity audit & multi-agent sign-off.
