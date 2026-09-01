---
description: Run a rescue operation with Copilot in write mode to diagnose and fix errors, failing tests, or broken builds with Git rollback tracking
argument-hint: '[--prompt "<task>"] [--error "<error-log>"] [--test "<test-command>"] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run an emergency rescue operation with Copilot through the bundled bridge in write mode.

Raw arguments: `$ARGUMENTS`

Rules:
- Rescue runs in write mode with automated Git rollback snapshotting (`git stash create`).
- Make exactly one bridge call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" rescue $ARGUMENTS --format markdown
```

- Report the terminal status, the verdict when present, every changed file, and the rollback reference.
- If the rescue introduces regressions or fails, use the reported rollback reference to revert changes cleanly.
- Never treat a zero exit code as success. Read `status` and `completed`.
- Pass `--stream` for real-time live output streaming during rescue diagnosis and execution.
