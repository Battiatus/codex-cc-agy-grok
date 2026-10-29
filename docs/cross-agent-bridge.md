# Cross-Agent Bridge Architecture: Connecting Claude Code, Codex, Grok & Antigravity

> **Français** : Architecture technique de la passerelle universelle entre Claude Code, OpenAI Codex, xAI Grok Build et Google Antigravity (ainsi que GitHub Copilot, Qwen Code et OpenCode).  
> **English**: Technical architecture of the universal cross-agent bridge connecting Claude Code, OpenAI Codex, xAI Grok Build, and Google Antigravity (plus GitHub Copilot, Qwen Code, and OpenCode).

---

## 1. Architectural Vision

Most AI coding assistants operate as walled gardens. **Polyglot Agent Connectors** breaks down these silos with a **symmetrical, local-first CLI bridge** (`plugins/polyglot/bin/agent-bridge.mjs`) that translates commands, scopes Git diffs, enforces JSON Schema contracts, and supervises background jobs across 7 providers. Each provider is a declarative config in `plugins/polyglot/bin/providers/<id>.json`; every job command takes `--to codex|claude|grok|agy|copilot|qwen|opencode`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CALLING AGENT HOST                              │
│     Claude Code  •  OpenAI Codex  •  xAI Grok Build  •  Antigravity     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              UNIFIED AGENT BRIDGE (bin/agent-bridge.mjs)                │
│  • Git Scope Resolution (uncommitted, staged, branch, commit)           │
│  • Cycle & Depth Guard (AGENT_CONNECTOR_CHAIN <= 3)                     │
│  • Isolation Engine (Git Worktrees / Credential-Filtered Copy)          │
│  • Write Gate (--mode write --confirm-write, polyglot/<job-id> branch)  │
│  • Schema Contract Enforcement (bin/schemas/review-output.schema.json)  │
│  • Provider Configs (bin/providers/<id>.json)                           │
└───────┬───────────────────┬───────────────────┬───────────────────┬─────┘
        │                   │                   │                   │
        ▼                   ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Codex CLI    │   │  Claude CLI   │   │  Grok Build   │   │  Antigravity  │
│  (OS Sandbox) │   │ (Tool Filter) │   │ (Tool Filter) │   │  (Plan Mode)  │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

GitHub Copilot, Qwen Code and OpenCode follow the same contract through their own provider configs.

---

## 2. Security & Safety Model (Zéro Fuite de Credentials)

### No Credential Broker Required
The bridge **never reads, stores, or translates API keys or tokens**. It inherits the local installation and authentication session of each target CLI (`claude auth status`, `codex login status`, `grok models`, `agy models`).

### Read-Only Default (`review` Mode)
By default, every delegation runs in `review` mode, with the provider's read-only profile:
- **Codex**: Enforced via native OS sandboxing (`--sandbox read-only`).
- **Claude Code**: Enforced via strict tool allowlisting (`--allowedTools Read,Glob,Grep` and `--permission-mode dontAsk`).
- **Grok Build**: Enforced via `--tools read_file,list_dir,grep` and explicit disallowance of `run_terminal_command,write,search_replace`, among others.
- **Antigravity**: Enforced via `--mode plan --sandbox` (not yet verified against a real run).
- **GitHub Copilot**: Enforced via `--deny-tool=write --deny-tool=shell`.
- **Qwen Code**: Enforced via `--approval-mode plan`.
- **OpenCode**: Enforced via the `OPENCODE_PERMISSION` environment variable denying edit and bash.

A review runs in place by default, so git history stays available and nothing is copied. `--isolate` runs it in a detached Git worktree, or in a credential-filtered copy outside git.

### Gated Write Mode & Isolated Git Branch
Write access is blocked unless both `--mode write` and `--confirm-write` are explicitly passed. `rescue` writes too, and needs `--confirm-write` as well: it does not confirm on its own. For a write job:
1. The bridge takes the current state of the repository (uncommitted tracked changes included) as the base and creates a git worktree on a `polyglot/<job-id>` branch.
2. The target agent works in that worktree. The user's working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway).
3. `filesChanged` is the exact diff `base..branch`. The result prints **Inspect** (`git diff <base> <branch>`), **Apply** (`git diff <base> <branch> | git apply`) and **Discard** (`git branch -D <branch>`).
4. Write mode outside a git repository is refused. `cancel` discards the job's branch, and a job that changes nothing leaves no branch behind.

### Prompt Delivery
The diff-embedding prompt is never a command-line argument. It goes on stdin (Codex `exec -`, Claude `-p`, Qwen, OpenCode `run`, Copilot), as one `stream-json` message on stdin (Antigravity), or via `--prompt-file` (Grok). This avoids `spawn ENAMETOOLONG` on Windows with large diffs.

### Recursion & Cycle Protection
When Agent A delegates to Agent B, the bridge appends the connector ID to `AGENT_CONNECTOR_CHAIN`.
- If Agent B attempts to delegate back to Agent A (a cycle), the bridge immediately refuses execution before any workspace isolation occurs.
- Chains deeper than 3 hops are hard-rejected to prevent runaway agent loops.

### Job State
Job state lives in `~/.agent-connectors/jobs/<job-id>/` (override with `AGENT_CONNECTOR_HOME`), not in the OS temp directory. The handoff transcript is recorded per working directory under `~/.agent-connectors/sessions/`.

---

## 3. Fail-Closed Verification Contract

Traditional shell wrappers assume `exitCode === 0` means success. In autonomous multi-agent systems, an agent can exit `0` while outputting a refusal, an empty scope, or a malformed response.

Polyglot Agent Connectors enforces a **fail-closed verification model**:
- `COMPLETED`: Valid JSON payload matching `review-output.schema.json` AND verdict is not `could-not-review`.
- `EMPTY_SCOPE`: The requested Git scope had no changes. Never reported as an approval.
- `COULD_NOT_REVIEW`: The target agent could not evaluate the diff.
- `SCHEMA_VIOLATION`: The agent output failed JSON schema validation.
- `COMPLETED_WITH_DENIALS`: The agent encountered permission denials during execution (`completed: false`).
- `SEMANTIC_MISMATCH`: Output did not match `--expect-response <exact-text>`.

Copilot and OpenCode have no schema flag: the schema travels in the prompt and the bridge validates the payload itself.

Bridge exit codes: `0` COMPLETED, `2` finished but not completed, `3` still running (`wait` timed out), `1` bridge error. The recommended flow is `--background`, then `wait <job-id>...`.

---

## 4. Cross-Host Plugin Packaging

The bridge ships as a single plugin, `plugins/polyglot`. There is no `src/` and no build step: the plugin source is the plugin. `npm run validate` (`scripts/validate-cross-host.mjs`) checks manifests, provider configs, commands, hooks and the review schema, and `node scripts/install.mjs --host claude|codex|grok|agy|qwen|opencode|copilot|all [--apply]` installs it (dry run by default). The package ships:
- `.codex-plugin/plugin.json` for OpenAI Codex
- `.claude-plugin/plugin.json` for Claude Code
- `plugin.json` & `hooks.json` for Google Antigravity
- `bin/providers/<id>.json` provider contracts (7)
- `commands/*.md` (11 slash commands: `/polyglot:review`, `adversarial-review`, `rescue`, `delegate`, `handoff`, `wait`, `runs`, `status`, `result`, `cancel`, `setup`)
- `skills/delegate/SKILL.md`
- `agents/delegate.md`
