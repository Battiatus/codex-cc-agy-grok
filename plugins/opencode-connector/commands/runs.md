---
description: Show unified runs dashboard and live supervision of agent execution jobs across connectors
argument-hint: '[--all] [--format json|markdown]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" runs $ARGUMENTS --format markdown`

Present the multi-agent runs dashboard table as returned.
