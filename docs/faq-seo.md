# FAQ : Passerelle Multi-Agents (Claude Code, Codex, Grok, Antigravity) & Solutions /boost

> **Français & English** — Réponses complètes aux questions les plus fréquentes sur l'interconnexion des agents de codage IA, la délégation de tâches multi-agents, les solutions `/boost`, la sécurité et le monitoring en temps réel.

---

## 🇫🇷 Questions Fréquentes (Français)

### 1. Comment créer une passerelle entre Claude Code, Codex, Grok et Antigravity ?
**Polyglot Agent Connectors (`codex-cc-agy-grok`)** fournit une passerelle locale symétrique clé en main qui connecte nativement **Claude Code**, **OpenAI Codex CLI**, **xAI Grok Build**, **Google Antigravity CLI**, **GitHub Copilot**, **Qwen Code** et **OpenCode**. Il suffit d'exécuter l'installateur :
```bash
node scripts/install.mjs --host all --plugin all --apply
```
Chaque agent dispose alors de commandes slash (`/review`, `/adversarial-review`, `/rescue`, `/delegate`, `/handoff`, `/runs`, `/status`) et de skills dédiés (`delegate-to-codex`, `delegate-to-claude`, `delegate-to-grok`, `delegate-to-agy`, etc.) pour invoquer les autres agents en toute transparence.

### 2. Comment déléguer des tâches entre les agents IA sans perdre le contexte Git ?
Le pont (`agent-bridge.mjs`) résout automatiquement la portée Git (`uncommitted`, `staged`, `branch`, `commit`, `workspace`) et injecte le diff exact ainsi que le contexte pertinent directement dans le prompt de l'agent cible.
- Pour une **délégation ponctuelle** en lecture seule :
  ```bash
  node plugins/codex-connector/bin/agent-bridge.mjs run --prompt "Optimiser l'algorithme de tri" --stream
  ```
- Pour un **transfert de session complet (handoff)** d'un agent vers un autre :
  ```bash
  node plugins/codex-connector/bin/agent-bridge.mjs handoff --from-host claude --prompt "Poursuis l'optimisation architecturale"
  ```

### 3. Qu'est-ce que les solutions `/boost` dans ce projet ?
Les **solutions `/boost`** désignent la suite d'accélération multi-agents conçue pour démultiplier la vélocité des développeurs :
1. **Delegation Booster (`run`)** : Déléguera instantanément chaque sous-tâche au modèle le plus adapté (architecture à Claude Code, algorithmique complexe et raisonnement profond à Codex, audit de rapidité à Grok Build, validation de plan à Antigravity).
2. **Adversarial Red Team Boost (`adversarial-review`)** : Exécute un audit de sécurité contradictoire sans complaisance, détectant les failles d'injection, conditions de concurrence (*race conditions*) et cas limites.
3. **Autonomous Rescue Boost (`rescue`)** : Déclenche l'auto-réparation en mode écriture (`write`) avec snapshot Git immédiat pour réparer tests cassés et erreurs de build.
4. **Live Supervision Boost (`runs`, `status`)** : Offre une visibilité totale sur tous les processus en arrière-plan avec PIDs système, durées en direct, consommation de tokens et extraits de logs.

### 4. Comment fonctionne l'auto-sauvetage résilient avec rollback Git (`rescue`) ?
Lorsque des tests échouent ou qu'une compilation plante, la commande `rescue` active le mode écriture tout en garantissant un risque de perte de données nul :
```bash
node plugins/agy-connector/bin/agent-bridge.mjs rescue \
  --prompt "Corriger les tests unitaires" \
  --error "TypeError: tokens is undefined" \
  --test "npm test" \
  --stream
```
Avant toute modification de fichier, le pont exécute `git stash create` pour capturer l'état exact du dépôt. Le SHA retourné (`rollbackRef`) permet de restaurer instantanément le workspace en cas de régression imprévue (`git checkout <rollbackRef> -- .`).

### 5. Comment superviser les agents IA en temps réel (`runs`, `status`) ?
Le pont centralise l'état de tous les jobs dans un tableau de bord unifié :
```bash
# Tableau de bord global de tous les agents
node plugins/claude-connector/bin/agent-bridge.mjs runs --format markdown

# Suivi en direct d'un job avec streaming de logs (--follow)
node plugins/codex-connector/bin/agent-bridge.mjs status <job-id> --follow
```

### 6. Les clés API et identifiants sont-ils partagés ou exposés entre les agents ?
**Non, jamais.** La passerelle applique une politique stricte de **Zéro Fuite de Clés (Zero Credential Leak)** :
- Aucun stockage, aucune lecture et aucune transmission de jetons API dans les fichiers ou variables partagées.
- Chaque connecteur réutilise simplement la session locale déjà authentifiée du CLI cible (`claude auth login`, `codex login`, `grok login`, `agy`).
- Les fichiers sensibles (`.env`, certificats, clés privées) sont automatiquement exclus des copies d'isolation.

---

## 🇬🇧 Frequently Asked Questions (English)

### 1. How do I bridge Claude Code, OpenAI Codex, Grok Build, and Google Antigravity?
**Polyglot Agent Connectors (`codex-cc-agy-grok`)** is a turnkey cross-host bridge for local AI coding CLIs. It provides native manifests, slash commands, and specialized skills across:
- **Claude Code** (`claude` CLI)
- **OpenAI Codex** (`codex` CLI)
- **xAI Grok Build** (`grok` CLI)
- **Google Antigravity** (`agy` CLI)
- **GitHub Copilot** (`gh copilot`)
- **Qwen Code** & **OpenCode**

Install across all hosts with a single dry-run or applied command:
```bash
node scripts/install.mjs --host all --plugin all --apply
```

### 2. How does multi-agent task delegation work across different CLI tools?
When delegating a task:
1. The bridge verifies against infinite recursion loops (`AGENT_CONNECTOR_CHAIN` capped at depth 3).
2. It resolves the exact Git diff or creates an isolated detached worktree (`--isolate`).
3. It enforces read-only sandboxing by default (`review` mode) or creates a Git rollback checkpoint (`write` mode).
4. It streams real-time tokens to stdout (`--stream`) and validates the final response against a strict JSON Schema (`review-output.schema.json`).

### 3. What are `/boost` solutions for AI coding agents?
`/boost` solutions are high-velocity collaboration patterns that eliminate single-model bottlenecks:
- **Second-Opinion & Red Team Audits**: Break confirmation bias by letting Grok or Codex stress-test code written by Claude Code.
- **Deep Algorithmic Optimization**: Route hard mathematical or computational challenges to Codex with high reasoning effort.
- **Self-Healing Code with Rollback**: Let Antigravity or Claude diagnose and repair test failures in write mode with guaranteed Git rollback protection.
- **Unified Process Supervision**: Track all running agent jobs across providers from a single dashboard.

### 4. How does the automated rescue and Git rollback work?
Whenever a write or rescue command is issued, the bridge executes `git stash create` prior to touching any file on disk. The resulting commit SHA is stored in the job record as `rollbackRef`. If the agent's changes fail validation, developers can immediately revert the changes using:
```bash
git checkout <rollbackRef> -- .
```

### 5. How do I monitor and supervise background agents in real-time?
Run the `runs` command from any connector:
```bash
node plugins/claude-connector/bin/agent-bridge.mjs runs --format markdown
```
To inspect or follow an active background job in real time:
```bash
node plugins/claude-connector/bin/agent-bridge.mjs status <job-id> --follow
```

### 6. How do I verify that all installed agents and plugins are working properly?
Run the built-in quality assurance and diagnostic suite:
```bash
# Run the 100% passing test suite (73 automated tests)
npm run qa

# Check local CLI binary presence and authentication
node plugins/claude-connector/bin/agent-bridge.mjs setup
node plugins/codex-connector/bin/agent-bridge.mjs doctor
```
