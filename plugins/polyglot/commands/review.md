---
description: Review the current git scope with another agent CLI and return a schema-validated verdict
argument-hint: '--to auto|codex|claude|grok|agy|copilot|qwen|opencode [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a review through the bundled bridge. Raw arguments: `$ARGUMENTS`

Rules:
- If `--to` is missing, ask which provider with `AskUserQuestion` (`auto` picks the one with the best recent record). Several providers means one job each.
- `--job <write-job-id>` reviews the branch another agent produced, in a worktree of that branch.
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Never construct provider commands yourself.

Run each job in the background, then wait:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <job-id> [<job-id>...] --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means a job is still running: call `wait` again with the same ids.

Reading the result:
- `COMPLETED` with `verdict: approve` is the only clean pass.
- `EMPTY_SCOPE` means there was nothing to review. Say so; it is not an approval.
- `COULD_NOT_REVIEW`, `SCHEMA_VIOLATION`, `COMPLETED_WITH_DENIALS`: report why and stop.
- Keep findings in the order returned, with file paths and line numbers verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
