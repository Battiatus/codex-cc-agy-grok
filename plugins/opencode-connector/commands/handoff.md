---
description: Hand this conversation's context to OpenCode as a derived context and continue the work there
argument-hint: '[--from-host claude|codex|grok|agy] [--source <transcript>] [--background] <task>'
allowed-tools: Bash(node:*)
---

Transfer context to OpenCode.

Raw arguments: `$ARGUMENTS`

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" handoff --from-host claude $ARGUMENTS --format markdown
```

Rules:
- The SessionStart hook records the transcript path, so `--source` is only needed when that failed.
- Label the outcome as a derived context transfer, never as a lossless session resume.
- If the bridge reports that no transcript could be identified, ask the user for `--source <path>`.
