---
description: Run an adversarial Red Team code review with Codex focusing on security vulnerabilities, edge cases, and exploit vectors
argument-hint: '[--focus <area>] [--scope auto|uncommitted|staged|branch|commit|workspace] [--base <ref>] [--commit <sha>] [--isolate] [--model <model>] [--effort <level>] [--stream] [--background] [--timeout 10m]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate an adversarial Red Team review to Codex through the bundled bridge.

Raw arguments: `$ARGUMENTS`

Rules:
- This command is review-only. Do not fix anything, do not edit any file, and do not offer to.
- Make exactly one bridge call and present its output. Never construct provider commands yourself.
- If the arguments include `--background`, launch the command with `run_in_background: true` and tell the user to check `/codex-connector:status`.
- Otherwise run it in the foreground.
- Pass `--stream` for real-time live output streaming to stdout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" adversarial-review $ARGUMENTS --format markdown
```

Reading the result:
- `COMPLETED` with `verdict: approve` means no critical vulnerabilities or edge-case failures were found in the scope.
- `EMPTY_SCOPE` means there was nothing to review. Say so; it is not an approval.
- `COULD_NOT_REVIEW` means Codex could not assess the change. Report why and stop.
- `SCHEMA_VIOLATION` means the payload was malformed. Report the schema errors and stop.
- `COMPLETED_WITH_DENIALS` means Codex was blocked from part of the work. List the denials.
- Keep findings in the order returned, with file paths, line numbers and severities verbatim.
- After presenting findings, ask which ones the user wants fixed. Never auto-apply a fix from a review.
