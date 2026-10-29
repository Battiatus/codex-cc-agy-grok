---
description: Dashboard of delegated jobs for this repository, with status totals and cost
argument-hint: '[--all] [--reap] [--stats]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" runs $ARGUMENTS --format markdown`

Present the dashboard as returned. Keep job ids, statuses and costs verbatim. `--stats` shows success rate, median time, cost and the usual failure per provider instead.
