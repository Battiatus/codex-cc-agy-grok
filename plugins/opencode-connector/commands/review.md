---
description: Run a OpenCode code review of the current git scope and return a schema-validated verdict
argument-hint: '[--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--background] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a review to OpenCode through the bundled bridge.

Raw arguments: `$ARGUMENTS`

Rules:
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Make exactly one bridge call and present its output. Never construct provider commands yourself.
- If the arguments include `--background`, launch the command with `run_in_background: true` and tell the user to check `/opencode-connector:status`.
- Otherwise run it in the foreground.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" review $ARGUMENTS --format markdown
```

Reading the result:
- `COMPLETED` with `verdict: approve` is the only clean pass.
- `EMPTY_SCOPE` means there was nothing to review. Say so; it is not an approval.
- `COULD_NOT_REVIEW` means OpenCode could not assess the change. Report why and stop.
- `SCHEMA_VIOLATION` means the payload was malformed. Report the schema errors and stop.
- `COMPLETED_WITH_DENIALS` means OpenCode was blocked from part of the work. List the denials.
- Keep findings in the order returned, with file paths and line numbers verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
