---
name: delegate
description: Delegate a git-scoped review or a bounded coding task to another local agent CLI (Codex, Claude Code, Grok Build, Antigravity, Copilot, Qwen Code, OpenCode) and track it to a schema-validated result. Use for an independent or adversarial review, a second diagnosis, a fix on a separate branch, a cross-provider handoff, or checking, waiting on and cancelling delegated jobs.
---

# Polyglot delegation

Always call the bundled bridge. Never construct a provider command line yourself.

Bridge: `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs"`
On a host that does not export `CLAUDE_PLUGIN_ROOT`, use the absolute path to this plugin's `bin/agent-bridge.mjs`.

Providers (`--to`): `codex`, `claude`, `grok`, `agy`, `copilot`, `qwen`, `opencode`. Run `setup` first when unsure which are installed and logged in.

## How to run a job

Launch in the background, then block on `wait`. A foreground call longer than the host's shell timeout gets killed and the job ends `STALE`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review --to codex --scope uncommitted --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> --format markdown
```

- Give `wait` a shell timeout of 600000 ms. Exit code 3 = still running: call `wait` again with the same ids.
- Several providers: launch one background job per provider, then `wait id1 id2 id3`.
- Exit codes: 0 completed, 2 finished without completing, 3 still running, 1 bridge error.

## Commands

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" setup --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review --to <p> --scope uncommitted|staged|branch|commit|workspace [--base main] --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" adversarial-review --to <p> --focus "security" --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --to <p> --prompt "<task>" --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --to <p> --prompt "<task>" --mode write --confirm-write --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" rescue --to <p> --error "<log>" --test "<cmd>" --confirm-write --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" handoff --to <p> --from-host claude --prompt "<task>" --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" resume --to <p> --session "<native-session-id>" --prompt "<follow-up>" --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id>... --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" runs --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" status <job-id> --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" result <job-id> --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" cancel <job-id>
```

## What the bridge guarantees

- `review` is the default mode and cannot write; the provider runs with its read-only profile.
- The bridge resolves the git scope and embeds the exact diff in the prompt, delivered on stdin, so large diffs work and the target sees the change without git tools.
- Reviews return a payload validated against `bin/schemas/review-output.schema.json`: `verdict`, `summary`, `findings[]` with file and line numbers, `next_steps[]`.
- `completed: true` requires a schema-valid payload whose verdict is not `could-not-review`.
- Writes need `--confirm-write` and run in a git worktree on a `polyglot/<job-id>` branch. The working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway); `filesChanged` is the exact branch diff, and the result gives Inspect / Apply / Discard commands.
- A write job starts from tracked files plus uncommitted tracked changes. Untracked and ignored files (new sources, `node_modules`) are not in its worktree; say so in the task when they matter.
- Credentials are never read or stored; each provider uses its own CLI login.
- Delegating back through the same provider is refused, as is a chain deeper than three.

## Statuses

| status | meaning |
| --- | --- |
| `COMPLETED` | valid payload returned; read `verdict` |
| `EMPTY_SCOPE` | nothing was in scope — not an approval |
| `COULD_NOT_REVIEW` | the target could not assess the change |
| `SCHEMA_VIOLATION` | payload missing or malformed; see `schemaErrors` |
| `COMPLETED_WITH_DENIALS` | the target was blocked; see `permissionDenials` |
| `SEMANTIC_MISMATCH` | `--expect-response` did not match exactly |
| `TIMEOUT`, `FAILED`, `CANCELED`, `STALE` | terminal failures |

See `references/reporting.md` for how to report an outcome.
