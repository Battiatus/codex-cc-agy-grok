# FAQ : Passerelle Multi-Agents (Claude Code, Codex, Grok, Antigravity) & Solutions /boost

> **Français & English** — Réponses complètes aux questions les plus fréquentes sur l'interconnexion des agents de codage IA, la délégation de tâches multi-agents, les solutions `/boost`, la sécurité et le suivi des jobs en direct.

---

## 🇫🇷 Questions Fréquentes (Français)

### 1. Comment créer une passerelle entre Claude Code, Codex, Grok et Antigravity ?
**Polyglot Agent Connectors (`codex-cc-agy-grok`)** fournit une passerelle locale symétrique clé en main qui connecte **Claude Code**, **OpenAI Codex CLI**, **xAI Grok Build**, **Google Antigravity CLI**, **GitHub Copilot**, **Qwen Code** et **OpenCode** via un seul plugin, `polyglot`. Il suffit d'exécuter l'installateur :
```bash
node scripts/install.mjs --host all --apply
```
Chaque agent dispose alors de 15 commandes slash (`/polyglot:review`, `/polyglot:adversarial-review`, `/polyglot:rescue`, `/polyglot:delegate`, `/polyglot:handoff`, `/polyglot:wait`, `/polyglot:runs`, `/polyglot:status`, `/polyglot:result`, `/polyglot:cancel`, `/polyglot:setup`, `/polyglot:apply`, `/polyglot:discard`, `/polyglot:retry`, `/polyglot:continue`), d'un skill `delegate` et d'un agent `delegate` pour invoquer les autres agents. Chaque commande de job prend `--to codex|claude|grok|agy|copilot|qwen|opencode`, ou `--to auto`.

### 2. Comment déléguer des tâches entre les agents IA sans perdre le contexte Git ?
Le pont (`agent-bridge.mjs`) résout automatiquement la portée Git (`auto`, `uncommitted`, `staged`, `branch`, `commit`, `workspace`) et injecte le diff exact directement dans le prompt de l'agent cible.
- Pour une **délégation ponctuelle** en lecture seule, lancez le job en arrière-plan puis attendez son résultat :
  ```bash
  node plugins/polyglot/bin/agent-bridge.mjs run --to codex --prompt "Optimiser l'algorithme de tri" --background
  node plugins/polyglot/bin/agent-bridge.mjs wait <job-id> --format markdown
  ```
- Pour solliciter plusieurs agents : un job en arrière-plan par provider, puis `wait id1 id2`.
- Pour un **transfert de contexte (handoff)** d'un agent vers un autre (un condensé dérivé de la conversation, pas une reprise de session à l'identique) :
  ```bash
  node plugins/polyglot/bin/agent-bridge.mjs handoff --to codex --from-host claude --prompt "Poursuis l'optimisation architecturale" --background
  ```

### 3. Qu'est-ce que les solutions `/boost` dans ce projet ?
Les **solutions `/boost`** désignent la suite de délégation multi-agents conçue pour démultiplier la vélocité des développeurs :
1. **Delegation Booster (`run`)** : Déléguera chaque sous-tâche au modèle le plus adapté (architecture à Claude Code, algorithmique complexe et raisonnement profond à Codex, audit de rapidité à Grok Build, validation de plan à Antigravity).
2. **Adversarial Red Team Boost (`adversarial-review`)** : Exécute un audit de sécurité contradictoire sans complaisance, détectant les failles d'injection, conditions de concurrence (*race conditions*) et cas limites.
3. **Autonomous Rescue Boost (`rescue`)** : Confie à un agent la réparation de tests cassés et d'erreurs de build en mode écriture (`write`), sur une branche Git isolée `polyglot/<job-id>`.
4. **Live Supervision Boost (`runs`, `wait`, `status`)** : Offre une visibilité sur tous les jobs en arrière-plan avec PIDs système, durées en direct, coût et extraits de logs.

### 4. Comment fonctionne l'auto-sauvetage résilient sur branche Git isolée (`rescue`) ?
Lorsque des tests échouent ou qu'une compilation plante, la commande `rescue` active le mode écriture (`--confirm-write` est obligatoire) sans jamais toucher à votre arbre de travail :
```bash
node plugins/polyglot/bin/agent-bridge.mjs rescue --to agy \
  --prompt "Corriger les tests unitaires" \
  --error "TypeError: tokens is undefined" \
  --test "npm test" \
  --confirm-write --background
```
Le pont crée un worktree Git sur la branche `polyglot/<job-id>`, à partir de l'état courant du dépôt (modifications suivies non commitées incluses), et l'agent y travaille. Le résultat liste les fichiers modifiés (`filesChanged`, le diff exact `base..branche`) la commande pour l'inspecter (`git diff <base> <branche>`). `review --to <autre> --job <id>` la fait relire par un autre agent, `apply <id>` l'applique à l'arbre de travail (tout ou rien, rien n'est indexé) et `discard <id>` la supprime. Hors dépôt Git, le mode écriture est refusé ; `cancel` supprime la branche d'un job d'écriture.

### 5. Comment superviser les agents IA en temps réel (`runs`, `status`, `wait`) ?
Le pont centralise l'état de tous les jobs dans un tableau de bord unifié :
```bash
# Tableau de bord des jobs du dépôt courant (--all pour tous les dépôts)
node plugins/polyglot/bin/agent-bridge.mjs runs --format markdown

# Suivi en direct du journal d'événements d'un job (--follow)
node plugins/polyglot/bin/agent-bridge.mjs status <job-id> --follow

# Attendre la fin d'un ou plusieurs jobs et récupérer leurs résultats complets
node plugins/polyglot/bin/agent-bridge.mjs wait <job-id> --format markdown
```
Codes de sortie : `0` COMPLETED, `2` terminé sans être complété, `3` toujours en cours (le délai de `wait` est écoulé), `1` erreur du pont.

### 6. Les clés API et identifiants sont-ils partagés ou exposés entre les agents ?
**Non, jamais.** La passerelle applique une politique stricte de **Zéro Fuite de Clés (Zero Credential Leak)** :
- Aucun stockage, aucune lecture et aucune transmission de jetons API dans les fichiers ou variables partagées.
- Le pont réutilise simplement la session locale déjà authentifiée du CLI cible (`claude auth login`, `codex login`, `grok login`, `agy`).
- Les fichiers sensibles (`.env`, certificats, clés privées) sont automatiquement exclus des copies d'isolation filtrées (`--isolate` hors dépôt Git).

---

## 🇬🇧 Frequently Asked Questions (English)

### 1. How do I bridge Claude Code, OpenAI Codex, Grok Build, and Google Antigravity?
**Polyglot Agent Connectors (`codex-cc-agy-grok`)** is a turnkey cross-host bridge for local AI coding CLIs. One plugin, `polyglot`, provides native manifests, 15 slash commands, a `delegate` skill and a `delegate` agent across:
- **Claude Code** (`claude` CLI)
- **OpenAI Codex** (`codex` CLI)
- **xAI Grok Build** (`grok` CLI)
- **Google Antigravity** (`agy` CLI)
- **GitHub Copilot** (standalone `copilot` CLI)
- **Qwen Code** & **OpenCode**

Install across all hosts with a single dry-run or applied command:
```bash
node scripts/install.mjs --host all --apply
```

### 2. How does multi-agent task delegation work across different CLI tools?
When delegating a task:
1. The bridge verifies against infinite recursion loops (`AGENT_CONNECTOR_CHAIN` capped at depth 3).
2. It resolves the exact Git diff, or creates an isolated detached worktree (`--isolate`).
3. It enforces read-only profiles by default (`review` mode), or runs a write job in a git worktree on a `polyglot/<job-id>` branch (`write` mode with `--confirm-write`).
4. It can stream provider output in real time (`--stream`) and validates the final response against the review JSON Schema (`review-output.schema.json`).

Launch with `--background`, then block on `wait <job-id>`.

### 3. What are `/boost` solutions for AI coding agents?
`/boost` solutions are high-velocity collaboration patterns that eliminate single-model bottlenecks:
- **Second-Opinion & Red Team Audits**: Break confirmation bias by letting Grok or Codex stress-test code written by Claude Code.
- **Deep Algorithmic Optimization**: Route hard mathematical or computational challenges to Codex with high reasoning effort.
- **Isolated Fixes**: Let Antigravity or Claude diagnose and repair test failures in write mode on a separate Git branch that you inspect, apply or discard.
- **Unified Process Supervision**: Track all running agent jobs across providers from a single dashboard.

### 4. How does rescue and the isolated Git branch work?
Whenever a write or rescue command is issued with `--confirm-write`, the bridge creates a git worktree on a `polyglot/<job-id>` branch, based on the current state of the repository, and the target agent works there. Your working tree is never written by the bridge (a job is flagged `sourceTreeModified` if the agent wrote there anyway). The result lists `filesChanged` (the exact diff `base..branch`) and what to do with the branch:
```bash
git diff <base> <branch>                                  # Inspect
node agent-bridge.mjs review --to <other> --job <job-id>  # Second opinion on the branch
node agent-bridge.mjs apply <job-id>                      # Apply to the working tree, all or nothing
node agent-bridge.mjs discard <job-id>                    # Delete the branch
```
Write mode outside a git repository is refused, and `cancel` discards the branch of a running write job.

### 5. How do I monitor and supervise background agents in real-time?
Run the `runs` command from any host:
```bash
node plugins/polyglot/bin/agent-bridge.mjs runs --format markdown
```
To inspect or follow an active background job in real time, or to block until jobs finish:
```bash
node plugins/polyglot/bin/agent-bridge.mjs status <job-id> --follow
node plugins/polyglot/bin/agent-bridge.mjs wait <job-id> --format markdown
```

### 6. How do I verify that all installed agents and plugins are working properly?
Run the built-in quality assurance and diagnostic suite:
```bash
# Run manifest and provider-contract validation, then the automated tests
npm run qa

# Check local CLI binary presence and authentication
node plugins/polyglot/bin/agent-bridge.mjs setup
node plugins/polyglot/bin/agent-bridge.mjs doctor
```
