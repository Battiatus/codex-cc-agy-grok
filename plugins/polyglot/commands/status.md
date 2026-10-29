---
description: Live status of one delegated job (PID, duration, stream activity, log tails), or the dashboard without an id
argument-hint: '[job-id] [--tail <lines>] [--all] [--reap]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" status $ARGUMENTS --format markdown`

Present the output as returned. Keep job ids, statuses and verdicts verbatim.
