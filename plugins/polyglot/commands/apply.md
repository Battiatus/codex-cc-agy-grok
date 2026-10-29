---
description: Apply a finished write job's polyglot/<job-id> branch to the working tree, all or nothing
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" apply $ARGUMENTS --format markdown`

Report the outcome verbatim. Nothing is staged or committed. If nothing was applied, say why and point to the inspect command; never apply the change another way.
