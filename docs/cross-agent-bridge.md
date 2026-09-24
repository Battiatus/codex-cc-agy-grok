# Cross-Agent Bridge Architecture: Connecting Claude Code, Codex, Grok & Antigravity

> **Français** : Architecture technique de la passerelle universelle entre Claude Code, OpenAI Codex, xAI Grok Build et Google Antigravity.  
> **English**: Technical architecture of the universal cross-agent bridge connecting Claude Code, OpenAI Codex, xAI Grok Build, and Google Antigravity.

---

## 1. Architectural Vision

Most AI coding assistants operate as walled gardens. **Polyglot Agent Connectors** breaks down these silos with a **symmetrical, local-first CLI bridge** (`src/bridge.mjs`) that translates commands, scopes Git diffs, enforces JSON Schema contracts, and supervises background jobs across all major providers.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CALLING AGENT HOST                              │
│     Claude Code  •  OpenAI Codex  •  xAI Grok Build  •  Antigravity     │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     UNIFIED AGENT BRIDGE (src/bridge.mjs)               │
│  • Git Scope Resolution (uncommitted, staged, branch, commit)           │
│  • Cycle & Depth Guard (AGENT_CONNECTOR_CHAIN <= 3)                     │
│  • Isolation Engine (Detached Git Worktrees / Credential-Filtered Copy) │
│  • Write Mutation Gate (--mode write --confirm-write + Git Stash Ref)   │
│  • Schema Contract Enforcement (schemas/review-output.schema.json)      │
└───────┬───────────────────┬───────────────────┬───────────────────┬─────┘
        │                   │                   │                   │
        ▼                   ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Codex CLI    │   │  Claude CLI   │   │  Grok Build   │   │  Antigravity  │
│  (OS Sandbox) │   │ (Tool Filter) │   │ (Tool Filter) │   │  (Plan Mode)  │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
```

---

## 2. Security & Safety Model (Zéro Fuite de Credentials)

### No Credential Broker Required
The bridge **never reads, stores, or translates API keys or tokens**. Each connector inherits the local installation and authentication session of its target CLI (`claude auth status`, `codex login status`, `grok models`, `agy models`).

### Read-Only Default (`review` Mode)
By default, every delegation runs in `review` mode:
- **Codex**: Enforced via native OS sandboxing (`--sandbox read-only`).
- **Claude Code**: Enforced via strict tool allowlisting (`--allowedTools Read,Glob,Grep` and `--permission-mode dontAsk`).
- **Grok Build**: Enforced via `--tools read_file,list_dir,grep` and explicit disallowance of `run_terminal_command,write,search_replace`.
- **Antigravity**: Enforced via `--mode plan --sandbox`.

### Gated Write Mode & Automatic Git Rollback
Write access is blocked unless both `--mode write` and `--confirm-write` are explicitly passed (or via `rescue`). Before any target agent modifies the workspace:
1. The bridge executes `git stash create` to capture an immutable snapshot of uncommitted work.
2. The resulting SHA is stored as `rollbackRef` in the job record.
3. Every modified, added, or deleted file is audited and listed in the final report.

### Recursion & Cycle Protection
When Agent A delegates to Agent B, the bridge appends the connector ID to `AGENT_CONNECTOR_CHAIN`.
- If Agent B attempts to delegate back to Agent A (a cycle), the bridge immediately refuses execution before any workspace isolation occurs.
- Chains deeper than 3 hops are hard-rejected to prevent runaway agent loops.

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

---

## 4. Cross-Host Plugin Packaging

Every connector in `plugins/<name>-connector` is built from `src/` via `npm run build` (`scripts/build-plugins.mjs`) and validated via `npm run validate` (`scripts/validate-cross-host.mjs`). Each package ships:
- `.codex-plugin/plugin.json` for OpenAI Codex
- `.claude-plugin/plugin.json` for Claude Code & Grok Build
- `plugin.json` & `hooks.json` for Google Antigravity
- `connector.json` runtime contract
- `commands/*.md` (10 slash commands)
- `skills/delegate-to-<id>/SKILL.md`
- `agents/delegate-to-<id>.md`
