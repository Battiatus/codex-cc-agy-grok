# Qwen Code Connector

Delegate bounded, git-scoped review and coding tasks to the local Qwen Code CLI from Codex, Claude Code, Grok Build, or Antigravity.

Self-contained package: manifests for Codex, Claude Code and Antigravity, slash commands, a forwarding subagent, session hooks, a skill, and the bridge with its output schema. Grok Build consumes the Claude-compatible layout directly.

## Runtime contract

- Target executable: `qwen`, resolved through a native binary, an npm shim entrypoint or a shebang, so Windows `.cmd` shims work
- Default mode: `review` — read-only, enforced by tool-allowlist, run in place so git history stays available
- Optional export: `--isolate` — a detached git worktree, or a credential-filtered copy outside git
- Mutation gate: `--mode write --confirm-write`, with a rollback ref and a changed-file list
- Output contract: `bin/schemas/review-output.schema.json`, passed as an inline schema
- Structured completion: `completed: true` requires a schema-valid payload whose verdict is not `could-not-review`
- Lifecycle: `setup`, `doctor`, `capabilities`, `review`, `adversarial-review`, `rescue`, `runs`, `run`, `resume`, `handoff`, `status`, `result`, `cancel`
- Metrics: `durationMs`, `usage`, and `costUsd` when the provider reports it
- Routing: `--model`, `--effort` (low, medium, high)
- State: `AGENT_CONNECTOR_HOME`, or the OS temporary directory under `agent-connectors/qwen`
- Authentication: inherited from the target CLI; never stored by this plugin

Run `node bin/agent-bridge.mjs help` for the machine-readable command summary, and `node bin/agent-bridge.mjs doctor` to verify every declared flag against the installed CLI.
