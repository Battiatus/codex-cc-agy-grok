---
description: Hand this conversation's context to another agent CLI as a derived digest and continue the work there
argument-hint: '--to codex|claude|grok|agy|copilot|qwen|opencode [--from-host claude|codex|grok|agy] [--source <transcript>] <task>'
allowed-tools: Bash(node:*), AskUserQuestion
---

Transfer context through the bundled bridge. Raw arguments: `$ARGUMENTS`

If `--to` is missing, ask which provider with `AskUserQuestion`. Use `--from-host claude` unless the arguments name another host.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" handoff --from-host claude $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means the job is still running: call `wait` again.

Rules:
- The SessionStart hook records the transcript path for this directory, so `--source` is only needed when that failed. If the bridge reports no transcript, ask the user for `--source <path>`.
- Label the outcome as a derived context transfer, never as a lossless session resume.
