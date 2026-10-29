---
description: Block until delegated jobs finish and show their results
argument-hint: '<job-id> [<job-id>...] [--timeout 9m]'
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait $ARGUMENTS --format markdown
```

Give the call a Bash timeout of 600000 ms. Exit code 3 means a job is still running: call it again with the same ids. Present each result in full; keep file paths, line numbers and severities verbatim. Do not apply any fix.
