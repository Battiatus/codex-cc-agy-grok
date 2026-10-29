# Project: codex-cc-agy-grok Modernization

## Architecture
One plugin, one bridge: a symmetrical polyglot multi-agent bridge enabling delegation, adversarial code reviews, rescue operations and live job supervision across 7 agent CLIs. The plugin source is `plugins/polyglot`; there is no `src/` and no build step.
- **Codex** (`codex`, OS sandbox)
- **Claude Code** (`claude`, tool allowlist)
- **Grok Build** (`grok`, tool allowlist)
- **Antigravity** (`agy`, plan mode)
- **GitHub Copilot** (standalone `copilot` CLI, deny-tool)
- **Qwen Code** (`qwen`, plan approval mode)
- **OpenCode** (`opencode run`, permission env)

### Data Flow & Components
- **CLI Bridge (`plugins/polyglot/bin/agent-bridge.mjs`, `bin/lib/args.mjs`)**: Command router handling `run`, `review`, `adversarial-review`, `rescue`, `resume`, `handoff`, `wait`, `runs`, `status`, `result`, `cancel`, `setup`, `doctor`, `capabilities`, `__worker`. Every job command takes `--to codex|claude|grok|agy|copilot|qwen|opencode`.
- **Provider configs (`bin/providers/<id>.json`)**: Declarative per-provider contract: binary, result adapter, capabilities (read-only enforcement, structured output mode), argument groups for review and write, prompt delivery (`stdin`, `file`), auth probe.
- **Job Store & Supervision (`bin/lib/jobs.mjs`, `bin/lib/provider.mjs`, `bin/lib/render.mjs`)**: Persistent job state under `~/.agent-connectors/jobs/<job-id>/` (override `AGENT_CONNECTOR_HOME`), NDJSON event journal, live process supervision, stale-job reaping, log tailing, `wait`, Markdown dashboard. Handoff transcripts are recorded per working directory under `~/.agent-connectors/sessions/`.
- **Git & Isolation Layer (`bin/lib/git.mjs`, `bin/lib/isolation.mjs`)**: Git scope resolution; reviews run in place by default, `--isolate` uses a detached worktree or a credential-filtered copy; write jobs run in a worktree on a `polyglot/<job-id>` branch.
- **Prompt & Invocation Engine (`bin/lib/invocation.mjs`, `bin/lib/parse.mjs`, `bin/lib/schema.mjs`)**: Diff-embedding prompt composition, argument building from provider configs, per-provider output parsing, review-schema validation.
- **Plugin surface (`commands/`, `skills/delegate/`, `agents/delegate.md`, `hooks.json`)**: 15 slash commands (`/polyglot:review`, `adversarial-review`, `rescue`, `delegate`, `handoff`, `wait`, `runs`, `status`, `result`, `cancel`, `setup`, `apply`, `discard`, `retry`, `continue`), one `delegate` skill, one `delegate` agent, SessionStart, UserPromptSubmit and SessionEnd hooks.

## v0.5.0 Changelog
- Live progress: while a job runs, `status` and `runs` show the agent's current action (tool, file, command), its last five actions, and output tokens and cost so far, read from the provider's event stream (codex, claude, opencode, agy). Claude now runs with `--output-format stream-json --verbose`. Qwen stays on `json`: in stream-json mode it never exits after answering, so it has no live progress.
- Notifications: a `UserPromptSubmit` hook tells the host, on its next prompt, which background jobs of the repository finished since it last read them (verdict, findings, branch, cost). Each job is announced once; `wait`, `result`, `status` and a foreground run count as read.
- Job actions: `apply <job-id>` applies a write job's branch to the working tree (all or nothing), `discard <job-id>` deletes it, `retry <job-id> [--to <other>]` replays the launch (a write needs `--confirm-write` again), `continue <job-id> --prompt` resumes the provider session of a job that ran in place, `review --to <p> --job <write-job-id>` has another agent review everything from the job's base to its branch tip, in a worktree of that branch.
- Routing: `--to auto` picks the installed, signed-in provider with the best completion rate over its last 20 jobs, skipping providers that do not support the options given, the delegation chain, Claude Code when it is the host, and with `--job` the job's author. `runs --stats` shows success rate, median time, cost and the usual failure per provider.
- Unverified: whether Codex runs the `UserPromptSubmit` hook (Claude Code does).

## v0.4.0 Changelog
- Seven per-provider plugins (`*-connector`) merged into the single `polyglot` plugin; providers are JSON configs.
- `src/`, `scripts/build-plugins.mjs`, `build-manifest.json` and `npm run build` removed.
- New `wait <job-id>... [--timeout 9m]`: blocks until jobs finish and returns full results. Recommended flow: `--background`, then `wait`.
- Exit codes: 0 COMPLETED, 2 finished but not completed, 3 still running, 1 bridge error.
- Write mode (`run --mode write`, `rescue`) requires `--confirm-write`; writes land on a `polyglot/<job-id>` branch in a worktree. The `rollbackRef` / `git stash` rollback is gone. Write outside a git repository is refused; `cancel` discards the branch.
- Prompts go on stdin (or `--prompt-file` for grok), fixing Windows `spawn ENAMETOOLONG` on large diffs.
- Real CLI flags for Copilot (standalone `copilot`), Qwen and OpenCode; Copilot and OpenCode carry the schema in the prompt and the bridge validates the payload.
- `runs` dashboard gains cost and a totals line; `status` without an id shows it.
- Job state moved from the OS temp directory to `~/.agent-connectors/`.
- Installer: `node scripts/install.mjs --host <host>|all [--apply]`; on Claude Code it first uninstalls the old `*-connector` plugins.
- `benchmarks/`, `parallel-policy.json` and `scripts/benchmark-parallelism.mjs` removed: no parallelism policy and no merged multi-agent review. Several agents means one background job per provider, then `wait`.
- Unverified: Grok and Copilot success output shapes (CLIs not logged in during verification) and Antigravity plan-mode read-only enforcement.

## Interface Contracts
### Bridge ↔ Provider Configs
- `plugins/polyglot/bin/providers/<id>.json` (`schemaVersion: 2`): `binary`, `resultAdapter`, `capabilities.structuredOutput` (`file`, `inline`, `prompt`), `capabilities.readOnlyEnforcement`, `invocation.baseArgs` / `reviewArgs` / `writeArgs` / `reviewEnv`, `invocation.promptVia` (`stdin`, `file`), optional `stdinTemplate`.
- Argument groups are all-or-nothing: a group with a missing placeholder value is dropped, never expanded to an empty string.
- Validated by `npm run validate` (`scripts/validate-cross-host.mjs`).

### Bridge ↔ Job Store
- `listJobs({ all, repositoryRoot })`: returns jobs sorted by `createdAt` desc, with `liveDurationMs`, `hostPid`, `model`, `promptSummary`.
- `readJobTails(jobId, { lines })`: returns `{ stdoutTail, stderrTail }`.
- `renderRunsDashboard(runs)`: a totals line, then a Markdown table `| provider | job | status | pid | model | duration | cost | activity | scope | prompt |`. `renderStats(stats)`: one row per provider (jobs, completed, success rate, median time, cost, top failure).
- `wait`: returns `{ done, pending, jobs }`; each finished job is its full stored result.

### Bridge ↔ Write Jobs
- `--mode write` and `rescue` need `--confirm-write`. The agent runs in a worktree on `polyglot/<job-id>`; the user's working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway).
- The result carries `branch`, `baseRef` and `filesChanged` (the exact diff `base..branch`), and prints the inspect command (`git diff <base> <branch>`). `apply <job-id>` runs `git diff --binary base branch | git apply` from the repository root (all or nothing), `discard <job-id>` removes the branch and any kept worktree.
- `adversarial-review`: `--focus <string>` (default "security, edge cases, vulnerability analysis, race conditions, failure modes"), review mode, review schema, Red Team prompt.
- `rescue`: `--error`, `--test`, `--prompt`; builds a rescue prompt and runs in write mode.

### Invocation Engine ↔ Agent Providers
- `composePrompt({ mode, ... })`: embeds the exact diff; in `review` mode it authorizes read tools (`grep`, `read_file`, `list_dir` / `Read`, `Glob`, `Grep`) and forbids mutations.
- The prompt reaches the provider on stdin (codex `exec -`, claude `-p`, qwen, opencode `run`, copilot), as one `stream-json` message on stdin (agy), or via `--prompt-file` (grok), never as a command-line argument.
- `AGENT_CONNECTOR_CHAIN` refuses a delegation back through a provider already in the chain and any chain deeper than 3.

## Code Layout
- `plugins/polyglot/bin/agent-bridge.mjs`: Central CLI dispatching all commands.
- `plugins/polyglot/bin/lib/args.mjs`: Strict CLI flag parser, duration parser, command list.
- `plugins/polyglot/bin/lib/jobs.mjs`: Job state, persistence, event journal, aggregation, stale reaping, log tails.
- `plugins/polyglot/bin/lib/provider.mjs`: Subprocess lifecycle, PID capture, chain guard, prompt delivery, write-branch settlement.
- `plugins/polyglot/bin/lib/invocation.mjs`: Prompt assembly and CLI argument generation from provider configs.
- `plugins/polyglot/bin/lib/parse.mjs`: Per-provider output parsing.
- `plugins/polyglot/bin/lib/git.mjs`, `isolation.mjs`: Git scope resolution, worktrees, execution roots.
- `plugins/polyglot/bin/lib/render.mjs`: Markdown and JSON formatting for results, runs dashboard, setup.
- `plugins/polyglot/bin/lib/schema.mjs`, `setup.mjs`, `transfer.mjs`, `exec.mjs`: Schema validation, readiness and flag audit, handoff digest, executable resolution.
- `plugins/polyglot/bin/providers/*.json`: One config per provider (`agy`, `claude`, `codex`, `copilot`, `grok`, `opencode`, `qwen`).
- `plugins/polyglot/bin/schemas/review-output.schema.json`: Review output contract.
- `plugins/polyglot/bin/session-hook.mjs`: SessionStart / SessionEnd hook (records the handoff transcript, reaps stale jobs).
- `plugins/polyglot/commands/`, `skills/delegate/`, `agents/delegate.md`, `hooks.json`: Plugin surface; manifests in `plugin.json`, `.claude-plugin/`, `.codex-plugin/`.
- `scripts/install.mjs`: Per-host installer (dry run by default). `scripts/validate-cross-host.mjs`: Manifest and provider-contract validator.
- `tests/`: `unit.test.mjs`, `bridge.test.mjs`, `mock-provider.mjs`, and the opt-in `real-cli.test.mjs`.
- `llms.txt` & `llms-full.txt`: Standard AI/LLM indexing specifications for search engines (Perplexity, Copilot, Google, Bing).
- `docs/`: Deep-dive guides (`boost-solutions.md`, `cross-agent-bridge.md`, `faq-seo.md`, `seo-guide.md`) and visual SVG assets (`docs/assets/hero-banner.svg`, `docs/assets/terminal-preview.svg`).
