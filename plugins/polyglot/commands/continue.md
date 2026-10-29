---
description: Send a follow-up to the agent of a finished job, in that agent's own session
argument-hint: '<job-id> --prompt "<follow-up>"'
allowed-tools: Bash(node:*)
---

Continue through the bundled bridge. Raw arguments: `$ARGUMENTS`

The follow-up goes to the same provider and native session, in the job's directory, read-only unless `--mode write --confirm-write` is given. Only a job that ran in place can be continued; for a write or `--isolate` job, use `retry`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" continue $ARGUMENTS --background
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" wait <new-job-id> --format markdown
```

Give the `wait` call a Bash timeout of 600000 ms. Exit code 3 means the job is still running: call `wait` again. Present the response verbatim.
