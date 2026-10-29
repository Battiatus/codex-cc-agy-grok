---
description: Cancel a running delegated job (a write job's branch is discarded)
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" cancel $ARGUMENTS --format markdown`
