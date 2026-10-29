---
description: Have another agent CLI fix a failing build or test on a separate polyglot/<job-id> branch
argument-hint: '--to auto|codex|claude|grok|agy|copilot|qwen|opencode [--prompt "<task>"] [--error "<error-log>"] [--test "<test-command>"] [--model <model>] [--effort <level>] [--timeout 20m]'
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a rescue through the bundled bridge. Raw arguments: `$ARGUMENTS`

Rules:
- If `--to` is missing, ask which provider with `AskUserQuestion`.
- Rescue writes. The target agent works in a git worktree on a `polyglot/<job-id>` branch; the user's working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway).
- Confirm with `AskUserQuestion` unless the user already authorised this write in this turn, then add `--confirm-write`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" rescue $ARGUMENTS --confirm-write --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means the job is still running: call `wait` again.

Report the terminal status, every changed file and the inspect command from the result. Never apply the branch without asking; when the user agrees, run `apply <job-id>` (all or nothing). Offer a second opinion with `review --to <other> --job <job-id>`. Never treat a zero exit code from the provider as success: only `status: COMPLETED` is.
