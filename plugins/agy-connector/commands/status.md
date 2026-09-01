---
description: Show Antigravity jobs for this repository with enriched live status, PID, live duration, model, prompt preview, and logs
argument-hint: '[job-id] [--all] [--reap]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" status $ARGUMENTS --format markdown`

Present the output as returned. Keep job ids, statuses and verdicts verbatim.
