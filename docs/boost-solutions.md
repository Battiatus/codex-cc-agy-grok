# Solutions /boost : Multi-Agent Task Delegation & Acceleration Suite

> **Français** : Guide complet des solutions `/boost` pour déléguer efficacement des tâches entre Claude Code, OpenAI Codex, xAI Grok Build, Google Antigravity, GitHub Copilot, Qwen Code et OpenCode.  
> **English**: Comprehensive guide to `/boost` solutions for high-velocity task delegation across Claude Code, OpenAI Codex, xAI Grok Build, Google Antigravity, GitHub Copilot, Qwen Code, and OpenCode.

---

## 1. What are /boost Solutions? (Qu'est-ce que les solutions /boost ?)

In modern AI-assisted software engineering, no single model or assistant excels across every domain:
- **Claude Code** is the premier choice for codebase architecture, semantic refactoring, and interactive human-in-the-loop flows.
- **OpenAI Codex** delivers unparalleled deep reasoning, algorithmic precision, and strict OS-sandboxed execution.
- **xAI Grok Build** provides ultra-fast turnarounds, razor-sharp Red Team critiques, and agile test triage.
- **Google Antigravity** shines at plan-mode architectural validation and structured workflows.
- **GitHub Copilot, Qwen Code & OpenCode** add more execution options through their standalone `copilot`, `qwen` and `opencode` CLIs.

The **/boost solutions suite** bridges these tools through **one plugin (`polyglot`) and one bridge** (`plugins/polyglot/bin/agent-bridge.mjs`), turning isolated CLIs into a **coordinated multi-agent toolkit**. Instead of juggling terminals or manually copy-pasting code, developers use unified `/boost` patterns: every job command takes `--to codex|claude|grok|agy|copilot|qwen|opencode`, runs in the background with `--background`, and returns through `wait`.

---

## 2. The 4 Pillars of /boost Solutions

```
                     ┌───────────────────────────────────────┐
                     │           /boost Solutions            │
                     │  Cross-Agent Delegation Suite         │
                     └──────────────────┬────────────────────┘
                                        │
         ┌──────────────────┬───────────┴──────────┬──────────────────┐
         ▼                  ▼                      ▼                  ▼
┌─────────────────┐┌─────────────────┐┌─────────────────┐┌─────────────────┐
│ 1. Delegation   ││ 2. Adversarial  ││ 3. Autonomous   ││ 4. Supervision  │
│    Booster      ││    Red Team     ││    Rescue       ││    & Wait       │
│                 ││                 ││                 ││                 │
│ Instant peer-to-││ Peer-agent      ││ Write-mode fix  ││ Live runs,      │
│ peer task       ││ security review ││ on an isolated  ││ PIDs, follow,   │
│ offloading      ││ & exploit audit ││ Git branch      ││ wait & cost     │
└─────────────────┘└─────────────────┘└─────────────────┘└─────────────────┘
```

### Pillar 1: Delegation Booster (Délégation Instantanée)
Offload specialized subtasks to the most qualified agent with a single command:
- **Architecture & System Design**: Claude Code (`claude`)
- **Algorithmic Logic & Mathematical Precision**: Codex (`codex`, `--effort high` or `xhigh`)
- **Fast Linting & Rapid Auditing**: Grok Build (`grok`)
- **Plan Verification**: Antigravity (`agy`, plan mode for read-only runs)
- **Tasks on Locally Configured Models**: Qwen Code (`qwen`) & OpenCode (`opencode`)

```bash
# From Claude Code or Antigravity, boost deep reasoning by delegating to Codex:
node plugins/polyglot/bin/agent-bridge.mjs run --to codex \
  --prompt "Analyze time-complexity bottleneck and optimize graph traversal" \
  --model o3-mini --effort high --background
node plugins/polyglot/bin/agent-bridge.mjs wait <job-id> --format markdown
```

### Pillar 2: Adversarial Red Team Review (Revue Contradictoire)
Single-model reviews suffer from confirmation bias. The `/boost` adversarial review unleashes a peer agent in Red Team mode to deliberately attack code, identify race conditions, detect injection vectors, and stress-test boundaries:

```bash
# Trigger an adversarial Red Team audit using Grok Build:
node plugins/polyglot/bin/agent-bridge.mjs adversarial-review --to grok \
  --focus "security, race conditions, memory leaks, privilege escalation" \
  --scope uncommitted --background
node plugins/polyglot/bin/agent-bridge.mjs wait <job-id> --format markdown
```

### Pillar 3: Autonomous Rescue on an Isolated Git Branch (Sauvetage et Auto-Guérison)
When tests fail or a build breaks, developers don't have to troubleshoot manually. The `/boost` rescue solution hands the fix to a peer agent in write mode, inside a git worktree on a `polyglot/<job-id>` branch, so **your working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway)**. Write mode always requires `--confirm-write`, and is refused outside a git repository:

```bash
# Trigger a rescue operation with Antigravity:
node plugins/polyglot/bin/agent-bridge.mjs rescue --to agy \
  --prompt "Fix failing unit tests in parser module" \
  --error "TypeError: Cannot read properties of undefined (reading 'tokens')" \
  --test "npm test" \
  --confirm-write --background
```
When the job finishes, the result lists every changed file (the exact diff `base..branch`) and the inspect command (`git diff <base> <branch>`). Then `review --to <other> --job <job-id>` has another agent review the branch, `apply <job-id>` applies it to the working tree (all or nothing, nothing staged) and `discard <job-id>` deletes it. `cancel` discards the branch of a running write job.

### Pillar 4: Supervision & Wait
Background jobs need visibility. The `/boost` suite integrates a unified dashboard across providers and a `wait` command that blocks until jobs finish and returns their full results:

```bash
# View the unified runs dashboard (jobs per status, total cost, one row per job)
node plugins/polyglot/bin/agent-bridge.mjs runs --format markdown

# Block until one or more jobs finish (exit code 3 = still running, call it again)
node plugins/polyglot/bin/agent-bridge.mjs wait <job-id-1> <job-id-2> --timeout 9m --format markdown

# Follow a running job's event journal in real time
node plugins/polyglot/bin/agent-bridge.mjs status <job-id> --follow
```
To ask several agents, launch one background job per provider, then `wait id1 id2`. Each provider's result comes back separately; the bridge does not merge them.

---

## 3. Real-World /boost Workflow Examples

### Scenario A: Full Feature Development Cycle
1. **Architect** with Claude Code: Design module seams and interface specifications.
2. **Implement & Logic Verify** with Codex: Pass algorithmic implementation to Codex via `/polyglot:delegate --to codex`.
3. **Red Team Review** with Grok Build: Execute `adversarial-review --to grok` on uncommitted git changes.
4. **Plan-Mode Verification** with Antigravity: Run a read-only `review --to agy` on the same scope.
5. **Supervise** with Unified Dashboard: Run `runs` to inspect all jobs, duration, PIDs, cost and logs, and `wait` to collect their results.

### Scenario B: Multi-Agent Handoff
Transfer a derived digest of the conversation from Claude Code to Codex or Grok (a derived context, not a lossless session resume):
```bash
node plugins/polyglot/bin/agent-bridge.mjs handoff --to codex \
  --from-host claude \
  --prompt "Continue implementing the streaming parser based on our architecture session" \
  --background
```

---

## 4. French Quickstart Summary (Résumé en Français)

Pour utiliser les solutions `/boost` dans vos projets quotidiens :
1. **Installation Clé en Main** : `node scripts/install.mjs --host all --apply`
2. **Délégation Instantanée** : `node plugins/polyglot/bin/agent-bridge.mjs run --to claude --prompt "<votre tâche>" --background`, puis `wait <job-id>`
3. **Audit de Sécurité Red Team** : `node plugins/polyglot/bin/agent-bridge.mjs adversarial-review --to grok --focus "sécurité" --background`
4. **Réparation sur Branche Git Isolée** : `node plugins/polyglot/bin/agent-bridge.mjs rescue --to codex --test "npm test" --confirm-write --background`
5. **Supervision en Direct** : `node plugins/polyglot/bin/agent-bridge.mjs runs`
