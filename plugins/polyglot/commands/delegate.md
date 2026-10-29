---
description: Delegate a bounded task to another agent CLI, read-only by default
argument-hint: '--to auto|codex|claude|grok|agy|copilot|qwen|opencode [--mode write] [--model <model>] [--effort <level>] [--timeout 10m] <task>'
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate through the bundled bridge. Raw arguments: `$ARGUMENTS`

Rules:
- If `--to` is missing, ask which provider with `AskUserQuestion` (`auto` picks the one with the best recent record). Several providers means one job each.
- Default to review mode. Use `--mode write --confirm-write` only when the user explicitly asked for changes, and confirm with `AskUserQuestion` unless they already authorised it in this turn. Writes land on a `polyglot/<job-id>` branch, never in the working tree.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" run --prompt "<task>" $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> [<job-id>...] --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means a job is still running: call `wait` again with the same ids.

Report the terminal status, the verdict when present, and for writes every changed file and the inspect command. Apply the branch only when the user asks, with `apply <job-id>`; `discard <job-id>` drops it. Only `status: COMPLETED` means completed.
