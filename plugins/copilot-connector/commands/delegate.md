---
description: Delegate a bounded task to Copilot, read-only by default
argument-hint: '[--mode write --confirm-write] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m] <task>'
allowed-tools: Bash(node:*), AskUserQuestion
---

Delegate to Copilot through the bundled bridge.

Raw arguments: `$ARGUMENTS`

Rules:
- Default to review mode. Pass `--mode write --confirm-write` only when the user explicitly asked Copilot to change files in this workspace.
- Before any write delegation, confirm with `AskUserQuestion` unless the user already authorised it in this turn.
- Make exactly one bridge call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --prompt "<task>" $ARGUMENTS --format markdown
```

- Report the terminal status, the verdict when present, every changed file, and the rollback reference for writes.
- Never treat a zero exit code as success. Read `status` and `completed`.
- Pass `--stream` to stream provider logs in real time.
