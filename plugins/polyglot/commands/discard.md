---
description: Delete a finished write job's polyglot/<job-id> branch and any worktree it kept
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" discard $ARGUMENTS --format markdown`

Report the outcome verbatim.
