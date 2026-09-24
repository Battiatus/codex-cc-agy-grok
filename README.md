# Bridge codex - grok - claude - antigravity

Four independent connector plugins let Codex, Claude Code, Grok Build, and Antigravity delegate bounded work to:

- `codex-connector` -> Codex CLI (`codex exec`)
- `grok-connector` → Grok Build (`grok`)
- `agy-connector` → Antigravity CLI (`agy`)
- `claude-connector` → Claude Code (`claude`)

Each package is self-contained and includes:

- a Codex manifest at `.codex-plugin/plugin.json`;
- a Claude Code manifest at `.claude-plugin/plugin.json`;
- an Antigravity `plugin.json`;
- Claude-compatible skills, which Grok Build also reads natively;
- one local bridge implementing `setup`, `run`, `status`, `result`, `cancel`, and `resume`.

The suite does not store or translate credentials. Every connector reuses the installation and authentication state of its target CLI.

## Safety model

`review` is the default mode. The connector copies the workspace to a temporary snapshot, excludes common generated directories, secret files, and symlinks, then runs the target agent against that copy. The source workspace remains untouched.

`write` operates on the source workspace and is rejected unless both `--mode write` and `--confirm-write` are supplied. Connector nesting is tracked in `AGENT_CONNECTOR_CHAIN`; cycles and chains deeper than three connectors are rejected.

A provider exit code of zero is not enough to claim success. The bridge reports `COMPLETED_WITH_DENIALS` when it detects an unmet permission or approval, with `completed: false`. Pass `--expect-response <exact-text>` for a semantic assertion: an empty or different target response returns `SEMANTIC_MISMATCH` with `completed: false`.

## Build and validate

```powershell
npm.cmd run qa
```

On macOS or Linux, use `npm run qa`.

## Preview cross-host installation

The installer is dry-run by default and prints every command before anything is changed:

```powershell
node scripts/install.mjs --host all --plugin all
```

Apply only to one chosen host:

```powershell
node scripts/install.mjs --host codex --plugin all --apply
node scripts/install.mjs --host claude --plugin all --apply
node scripts/install.mjs --host grok --plugin all --apply
node scripts/install.mjs --host agy --plugin all --apply
```

The shared marketplace is `.claude-plugin/marketplace.json`. Claude Code consumes it directly; Grok Build reads Claude-compatible marketplaces and plugins; Codex accepts it as its documented legacy-compatible marketplace format. Antigravity installs each package directory through `agy plugin install`.

## Direct bridge usage

```powershell
node plugins/grok-connector/bin/agent-bridge.mjs setup
node plugins/grok-connector/bin/agent-bridge.mjs run --prompt "Review this change" --cwd . --background
node plugins/grok-connector/bin/agent-bridge.mjs status
node plugins/grok-connector/bin/agent-bridge.mjs result <job-id>
node plugins/grok-connector/bin/agent-bridge.mjs cancel <job-id>
node plugins/grok-connector/bin/agent-bridge.mjs run --prompt "Read README.md" --cwd . --expect-response "CONNECTOR_OK"
```

State defaults to the operating system temporary directory under `agent-connectors/<connector>`, which remains writable when the calling host uses a filesystem sandbox. Set `AGENT_CONNECTOR_HOME` to a durable local directory when jobs must survive temporary-directory cleanup.

## Scope of version 0.2.0

This is a local-CLI pilot. It intentionally does not provide a hosted credential broker, a universal lossless session format, automatic consensus, or concurrent writers on one workspace. Cross-provider handoffs are new derived contexts; native `resume` remains provider-specific.

## Parallelism gate

Sub-agent parallelism is disabled by default in [`benchmarks/parallel-policy.json`](benchmarks/parallel-policy.json). It may only be enabled after a paired benchmark shows no correctness regression and a measurable efficiency gain. Use `npm.cmd run benchmark:parallel -- --baseline <single.json> --candidate <parallel.json>` to evaluate recorded runs. The gate requires at least five paired attempts, identical test cases, no extra failures, and a 20% gain in latency, tokens, or cost without a material regression in the other available efficiency metrics.
