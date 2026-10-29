---
description: Check which agent CLIs are installed, authenticated and flag-compatible
argument-hint: '[--to <provider>] [--doctor]'
allowed-tools: Bash(node:*)
---

Run the readiness check (all providers unless `--to` is given):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" setup $ARGUMENTS --format markdown
```

If the user passed `--doctor`, run `node "${CLAUDE_PLUGIN_ROOT}/bin/agent-bridge.mjs" doctor` instead (drop `--doctor` from the arguments) and present the flag audit, reaped jobs and state root.

For each provider: if `installed` is false, give the install hint; if `authenticated` is false, give the remediation command. Do not delegate to a provider until both are true.
