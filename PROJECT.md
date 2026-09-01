# Project: codex-cc-agy-grok Modernization

## Architecture
A unified, symmetrical polyglot multi-agent bridge and connector suite enabling seamless delegation, adversarial code reviews, rescue operations, and live job supervision across 5 primary agent CLIs:
- **Codex** (`plugins/codex-connector`, binary `codex`, OS sandbox)
- **Claude Code** (`plugins/claude-connector`, binary `claude`, tool allowlist)
- **Antigravity** (`plugins/agy-connector`, binary `agy`, plan mode)
- **Grok Build** (`plugins/grok-connector`, binary `grok`, tool allowlist)
- **Copilot** (`plugins/copilot-connector`, binary `gh`, tool allowlist)
(Plus `qwen-connector` and `opencode-connector` as compatible extensions)

### Data Flow & Components
- **CLI Bridge (`src/bridge.mjs`, `src/lib/args.mjs`)**: Command router handling `run`, `review`, `adversarial-review`, `rescue`, `runs`, `status`, `result`, `cancel`, `handoff`, `resume`, `setup`, `doctor`, `capabilities`, `__worker`.
- **Job Store & Supervision (`src/lib/jobs.mjs`, `src/lib/provider.mjs`, `src/lib/render.mjs`)**: Persistent JSON job states under `~/.agent-connectors/<connector>/jobs/<jobId>/`, live process supervision, PID tracking, live duration calculation, log tailing (`stdout`, `stderr`), Markdown dashboard tables.
- **Git & Safety Layer (`src/lib/git.mjs`, `src/lib/isolation.mjs`)**: Automated `git stash create` rollback point capture on write/rescue tasks, detached worktree isolation, filtered-copy fallbacks.
- **Prompt & Invocation Engine (`src/lib/invocation.mjs`, `src/lib/parse.mjs`)**: Context digest composition, read-tool unblocking (`read_file`, `list_dir`, `grep`) for review modes, wire-protocol JSON/NDJSON output parsing across providers.
- **Plugin Builder & Cross-Host Validator (`scripts/build-plugins.mjs`, `scripts/validate-cross-host.mjs`)**: Automatic manifest generation (`.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `plugin.json`, `connector.json`, `hooks/hooks.json`), command documentation (`review.md`, `adversarial-review.md`, `rescue.md`, `runs.md`, `status.md`, `result.md`, `cancel.md`, `delegate.md`, `handoff.md`, `setup.md`), and cross-host schema integrity checking.

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | `runs` command | Unified multi-agent runs dashboard & live supervision across connectors | M1 | ORIGINAL_REQUEST §R1 | DONE |
| 2 | `status` enrichment | Live duration, host PID, model, prompt preview, stdout/stderr tails | M1 | ORIGINAL_REQUEST §R1 | DONE |
| 3 | `adversarial-review` | Red Team adversarial review command with `--focus` flag | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 4 | `rescue` command | Write-mode rescue with `--error`, `--test`, and Git stash rollback ref | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 5 | Peer Agent Parity | Symmetrical command execution across Codex, Claude, Grok, Agy, Copilot | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 6 | Review Tool Unblocking | Allow read tools (grep, read_file, list_dir) during review in `invocation.mjs` | M3 | ORIGINAL_REQUEST §R3 | DONE |
| 7 | Parallelism Policy | Configure `enabled: true`, `defaultMaxConcurrentSubagents: 4` in `parallel-policy.json` | M3 | ORIGINAL_REQUEST §R3 | DONE |
| 8 | Manifest Generation | Generate all 7+ command markdown files in `scripts/build-plugins.mjs` | M4 | ORIGINAL_REQUEST §R4 | DONE |
| 9 | Validator Parity | Update `REQUIRED_COMMANDS` and validation in `scripts/validate-cross-host.mjs` | M4 | ORIGINAL_REQUEST §R4 | DONE |
| 10 | QA Suite 100% Pass | Full unit, bridge, benchmark, and validation test suite with 0 failures | M5 | ORIGINAL_REQUEST §Acceptance Criteria | DONE |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Runs Dashboard & Live Supervision | `src/lib/args.mjs`, `src/bridge.mjs`, `src/lib/jobs.mjs`, `src/lib/render.mjs`, unit/bridge tests | none | DONE |
| 2 | M2: Flagship Commands Parity | `src/lib/args.mjs`, `src/bridge.mjs`, `src/lib/invocation.mjs`, unit/bridge tests | M1 | DONE |
| 3 | M3: Tool Unblocking & Concurrency | `src/lib/invocation.mjs`, `benchmarks/parallel-policy.json`, `tests/benchmark-parallelism.test.mjs` | none | DONE |
| 4 | M4: Manifest Generation & Plugin Build | `scripts/build-plugins.mjs`, `scripts/validate-cross-host.mjs`, `plugins/*` | M1, M2, M3 | DONE |
| 5 | M5: E2E Verification & Forensic Audit | `npm run qa`, CLI command checks, adversarial review & rescue verifications | M1, M2, M3, M4 | DONE |

## Interface Contracts
### CLI Bridge ↔ Job Store
- `listAllRuns({ repositoryRoot, all })`: returns `Array<JobRecord>` sorted by `createdAt` desc, with `liveDurationMs`, `hostPid`, `model`, `promptSummary`.
- `readJobTails(connectorId, jobId, lines)`: returns `{ stdoutTail: string, stderrTail: string }`.
- `renderRunsDashboard(jobs)`: renders Markdown table `| connector | job | status | pid | model | duration | scope | prompt |`.

### CLI Bridge ↔ Flagship Commands
- `adversarial-review`: `--focus <string>` (defaults to "security, edge cases, vulnerability analysis, race conditions, failure modes"), runs in `review` mode with `review` schema, Red Team prompt.
- `rescue`: `--error <string>`, `--test <string>`, `--prompt <string>`, runs in `write` mode (`confirm-write: true`), invokes `stashCreate`, returns `rollbackRef`.

### Invocation Engine ↔ Agent Providers
- `composePrompt({ mode, ... })`: in `review` mode, explicitly authorizes `grep`, `read_file`, `list_dir` / `Read`, `Glob`, `Grep` for repository exploration while forbidding write/delete mutations.

## Code Layout
- `src/bridge.mjs`: Central CLI dispatching all commands.
- `src/lib/args.mjs`: CLI flag parser and command definitions.
- `src/lib/jobs.mjs`: Job state management, persistence, multi-connector aggregation, log tail extraction.
- `src/lib/render.mjs`: Markdown & JSON formatting for jobs, results, runs dashboard, status.
- `src/lib/invocation.mjs`: Prompt assembly and CLI argument generation.
- `src/lib/provider.mjs`: Subprocess lifecycle, PID capture, rollback stash tracking, output parsing.
- `src/lib/git.mjs`: Git scope resolution and `stashCreate` rollback mechanism.
- `benchmarks/parallel-policy.json`: Concurrency policy configuration.
- `scripts/build-plugins.mjs`: Artifact distributor and manifest generator.
- `scripts/validate-cross-host.mjs`: Cross-host manifest & build freshness validator.
- `tests/`: Automated test suite (`unit.test.mjs`, `bridge.test.mjs`, `benchmark-parallelism.test.mjs`, `mock-provider.mjs`).
- `plugins/`: 7 connector plugin packages (`codex-connector`, `claude-connector`, `agy-connector`, `grok-connector`, `copilot-connector`, `qwen-connector`, `opencode-connector`).
