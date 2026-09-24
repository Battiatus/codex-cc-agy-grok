# Solutions /boost : Multi-Agent Task Delegation & Acceleration Suite

> **Français** : Guide complet des solutions `/boost` pour orchestrer et déléguer efficacement des tâches entre Claude Code, OpenAI Codex, xAI Grok Build, Google Antigravity, GitHub Copilot, Qwen Code et OpenCode.  
> **English**: Comprehensive guide to `/boost` solutions for high-velocity task delegation across Claude Code, OpenAI Codex, xAI Grok Build, Google Antigravity, GitHub Copilot, Qwen Code, and OpenCode.

---

## 1. What are /boost Solutions? (Qu'est-ce que les solutions /boost ?)

In modern AI-assisted software engineering, no single model or assistant excels across every domain:
- **Claude Code** is the premier choice for codebase architecture, semantic refactoring, and interactive human-in-the-loop flows.
- **OpenAI Codex** delivers unparalleled deep reasoning, algorithmic precision, and strict OS-sandboxed execution.
- **xAI Grok Build** provides ultra-fast turnarounds, razor-sharp Red Team critiques, and agile test triage.
- **Google Antigravity** shines at plan-mode architectural validation, multi-directory navigation, and structured workflows.
- **GitHub Copilot, Qwen Code & OpenCode** provide open-weights and IDE-integrated execution options.

The **/boost solutions suite** bridges these tools, turning isolated CLIs into an **autonomous multi-agent powerhouse**. Instead of juggling terminals or manually copy-pasting code, developers use unified `/boost` patterns to delegate tasks instantaneously.

---

## 2. The 4 Pillars of /boost Solutions

```
                     ┌───────────────────────────────────────┐
                     │           /boost Solutions            │
                     │  Cross-Agent Orchestration Suite      │
                     └──────────────────┬────────────────────┘
                                        │
         ┌──────────────────┬───────────┴──────────┬──────────────────┐
         ▼                  ▼                      ▼                  ▼
┌─────────────────┐┌─────────────────┐┌─────────────────┐┌─────────────────┐
│ 1. Delegation   ││ 2. Adversarial  ││ 3. Autonomous   ││ 4. Supervision  │
│    Booster      ││    Red Team     ││    Rescue       ││    & Benchmark  │
│                 ││                 ││                 ││                 │
│ Instant peer-to-││ Multi-model     ││ Self-healing    ││ Live runs,      │
│ peer task       ││ security review ││ write-mode with ││ PIDs, follow,   │
│ offloading      ││ & exploit audit ││ Git rollback    ││ & token meters  │
└─────────────────┘└─────────────────┘└─────────────────┘└─────────────────┘
```

### Pillar 1: Delegation Booster (Délégation Instantanée)
Offload specialized subtasks to the most qualified agent with a single command:
- **Architecture & System Design**: Claude Code (`claude`)
- **Algorithmic Logic & Mathematical Precision**: Codex (`codex`, `--effort high` or `xhigh`)
- **Fast Linting & Rapid Auditing**: Grok Build (`grok`)
- **Plan Verification & Multi-Path Scoping**: Antigravity (`agy`, `--mode plan`)
- **Private & Local Code Tasks**: Qwen Code (`qwen`) & OpenCode (`opencode`)

```bash
# From Claude Code or Antigravity, boost deep reasoning by delegating to Codex:
node plugins/codex-connector/bin/agent-bridge.mjs run \
  --prompt "Analyze time-complexity bottleneck and optimize graph traversal" \
  --model o3-mini --effort high --stream --format markdown
```

### Pillar 2: Adversarial Red Team Review (Revue Contradictoire)
Single-model reviews suffer from confirmation bias. The `/boost` adversarial review unleashes a peer agent in Red Team mode to deliberately attack code, identify race conditions, detect injection vectors, and stress-test boundaries:

```bash
# Trigger an adversarial Red Team audit using Grok Build:
node plugins/grok-connector/bin/agent-bridge.mjs adversarial-review \
  --focus "security, race conditions, memory leaks, privilege escalation" \
  --scope uncommitted --stream --format markdown
```

### Pillar 3: Autonomous Rescue with Git Rollback (Sauvetage et Auto-Guérison)
When tests fail or a build breaks, developers don't have to troubleshoot manually. The `/boost` rescue solution spins up write-mode fixes while guaranteeing **zero accidental data loss** through automatic `git stash create` snapshots:

```bash
# Trigger an automated rescue operation with Antigravity:
node plugins/agy-connector/bin/agent-bridge.mjs rescue \
  --prompt "Fix failing unit tests in parser module" \
  --error "TypeError: Cannot read properties of undefined (reading 'tokens')" \
  --test "npm test" \
  --stream --format markdown
```
If the rescue succeeds, tests pass. If unexpected regressions occur, the exact `rollbackRef` is displayed to revert instantly with `git checkout <rollbackRef> -- .` (or `git stash apply <rollbackRef>`).

### Pillar 4: Supervision & Concurrency Gate
Sub-agent parallelism without quality gates leads to token thrashing and regressions. The `/boost` suite integrates real-time process supervision and a strict parallelism gate (`benchmarks/parallel-policy.json`):

```bash
# View unified multi-agent runs dashboard across all connectors
node plugins/claude-connector/bin/agent-bridge.mjs runs --format markdown

# Follow a running job in real time with live log stream
node plugins/codex-connector/bin/agent-bridge.mjs status <job-id> --follow
```

---

## 3. Real-World /boost Workflow Examples

### Scenario A: Full Feature Development Cycle
1. **Architect** with Claude Code: Design module seams and interface specifications.
2. **Implement & Logic Verify** with Codex: Pass algorithmic implementation to Codex via `/boost delegate`.
3. **Red Team Review** with Grok Build: Execute `adversarial-review` on uncommitted git changes.
4. **Plan-Mode Verification** with Antigravity: Run `setup` and cross-directory integration check.
5. **Supervise** with Unified Dashboard: Run `runs` to inspect all active jobs, duration, PIDs, and logs.

### Scenario B: Multi-Agent Handoff
Transfer conversational context seamlessly from Claude Code to Codex or Grok:
```bash
node plugins/codex-connector/bin/agent-bridge.mjs handoff \
  --from-host claude \
  --prompt "Continue implementing the streaming parser based on our architecture session" \
  --stream --format markdown
```

---

## 4. French Quickstart Summary (Résumé en Français)

Pour utiliser les solutions `/boost` dans vos projets quotidiens :
1. **Installation Clé en Main** : `node scripts/install.mjs --host all --plugin all --apply`
2. **Délégation Instantanée** : `node plugins/claude-connector/bin/agent-bridge.mjs run --prompt "<votre tâche>" --stream`
3. **Audit de Sécurité Red Team** : `node plugins/grok-connector/bin/agent-bridge.mjs adversarial-review --focus "sécurité"`
4. **Auto-Réparation & Rollback** : `node plugins/codex-connector/bin/agent-bridge.mjs rescue --test "npm test"`
5. **Supervision en Direct** : `node plugins/agy-connector/bin/agent-bridge.mjs runs`
