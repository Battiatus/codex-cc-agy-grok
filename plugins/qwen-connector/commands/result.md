---
description: Show the stored result of a finished Qwen Code job
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" result $ARGUMENTS --format markdown`

Present the full output. Do not summarise. Keep file paths, line numbers and severities verbatim. Do not apply any fix.
