---
description: Red Team review of the current git scope by another agent CLI, focused on security, edge cases and failure modes
argument-hint: '--to codex|claude|grok|agy|copilot|qwen|opencode [--focus <area>] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate an adversarial review through the bundled bridge. Raw arguments: `$ARGUMENTS`

Rules:
- If `--to` is missing, ask which provider with `AskUserQuestion`. Several providers means one job each.
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Never construct provider commands yourself.

Run each job in the background, then wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" adversarial-review $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> [<job-id>...] --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means a job is still running: call `wait` again with the same ids.

Reading the result:
- `COMPLETED` with `verdict: approve` means nothing critical was found in the scope.
- `EMPTY_SCOPE` means there was nothing to review. Say so; it is not an approval.
- `COULD_NOT_REVIEW`, `SCHEMA_VIOLATION`, `COMPLETED_WITH_DENIALS`: report why and stop.
- Keep findings in the order returned, with file paths, line numbers and severities verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
