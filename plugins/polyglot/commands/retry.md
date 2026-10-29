---
description: Run a finished delegated job again, on the same provider or another one
argument-hint: '<job-id> [--to auto|codex|claude|grok|agy|copilot|qwen|opencode] [--model <model>] [--effort <level>] [--timeout 10m]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Retry through the bundled bridge. Raw arguments: `$ARGUMENTS`

The retry replays the original command, directory, scope and prompt. A retried write job needs `--confirm-write` again: confirm with `AskUserQuestion` unless the user already authorised this write in this turn.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" retry $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <new-job-id> --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means the job is still running: call `wait` again. Report the result as the original command would. Only `status: COMPLETED` means completed.
