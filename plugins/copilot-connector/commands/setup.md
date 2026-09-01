---
description: Check whether the local Copilot CLI is installed, authenticated and flag-compatible
argument-hint: '[--doctor]'
allowed-tools: Bash(node:*)
---

Run the readiness check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" setup --format markdown
```

If the user passed `--doctor`, run this instead and present the flag audit, reaped jobs and state root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" doctor
```

If `installed` is false, give the install hint. If `authenticated` is false, give the remediation command and stop. Do not attempt a delegation until both are true.
