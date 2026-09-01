---
name: delegate-to-opencode
description: Delegate a bounded review or coding task to OpenCode through the local opencode CLI, with a git-scoped diff and a schema-validated verdict. Use for independent review, second diagnosis, cross-provider handoff, status, results or cancellation.
---

# OpenCode Connector

Always call the bundled bridge. Never construct `opencode` command lines yourself.

Bridge: `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs"`
On a host that does not export `CLAUDE_PLUGIN_ROOT`, use the absolute path to this plugin's `bin/agent-bridge.mjs`.

## What the bridge guarantees

- `review` is the default mode and cannot write. The provider runs with a read-only profile: tool-allowlist.
- The bridge resolves the git scope itself and embeds the exact diff in the prompt, so OpenCode sees the change even without shell or git tools.
- Review returns a payload validated against `bin/schemas/review-output.schema.json`: `verdict`, `summary`, `findings[]` with file and line numbers, and `next_steps[]`.
- `completed: true` requires a schema-valid payload whose verdict is not `could-not-review`. A zero exit code is never sufficient.
- Nothing is copied out of the workspace by default. `--isolate` creates a detached git worktree, or outside git a copy that refuses credentials and gitignored files.
- `write` requires `--mode write --confirm-write`, records a rollback ref and reports every changed file.
- Credentials are never read or stored; the bridge inherits the OpenCode login.
- Delegating back through the same connector is refused, as is a chain deeper than three connectors.

## Commands

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" setup --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review --scope uncommitted --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review --scope branch --base main --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" adversarial-review --focus "security" --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" rescue --prompt "<task>" --error "<error-log>" --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --prompt "<task>" --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --prompt "<task>" --mode write --confirm-write --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" handoff --from-host claude --prompt "<task>" --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" resume --session "<native-session-id>" --prompt "<follow-up>"
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" runs --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" status --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" result <job-id> --format markdown
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" cancel <job-id>
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" doctor
```

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
