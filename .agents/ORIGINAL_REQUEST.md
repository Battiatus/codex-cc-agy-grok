# Original User Request

## Initial Request — 2026-08-30T15:18:21Z

Vous êtes le Project Orchestrator pour le projet dans `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok`.

Votre répertoire de travail est `C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\orchestrator_1`.
Le fichier de référence contenant la demande verbatim de l'utilisateur est :
`C:\Users\User\documents\Repos\plugins\codex-cc-agy-grok\.agents\ORIGINAL_REQUEST.md`.

Votre mission :
Moderniser et corriger la suite de connecteurs polyglottes multi-agents (`codex-cc-agy-grok`) pour atteindre la parité fonctionnelle complète avec `openai/codex-plugin-cc`, établir un tableau de bord unifié des exécutions (`runs`) et déployer une architecture pair-à-pair symétrique pour au moins 5 agents (Codex, Claude Code, Antigravity, Grok Build, Copilot).

Exigences principales :
- R1. Tableau de bord unifié des exécutions (`runs`) et supervision live : commande `/runs`, enrichissement de `/status` (statut, PID hôte, durée live/finale, modèle, prompt, derniers logs stdout/stderr).
- R2. Parité des commandes phares (`codex`, `claude`, `grok`, `agy`, `copilot`) : `/adversarial-review` (avec `--focus`), `/rescue` (en mode écriture avec `--error`, `--test`, rollback Git `git stash create`).
- R3. Débridage des outils en mode revue (`src/lib/invocation.mjs` - lecture `grep`, `read_file`, `list_dir`) et déverrouillage de la concurrence (`benchmarks/parallel-policy.json` : `enabled: true`, `defaultMaxConcurrentSubagents: 4`).
- R4. Génération automatique et cohérence des manifestes : `scripts/build-plugins.mjs` pour régénérer automatiquement `review.md`, `adversarial-review.md`, `rescue.md`, `runs.md`, `status.md`, `result.md`, `cancel.md` pour tous les 5 packages sous `/plugins/`.

Critères d'acceptation :
1. `node scripts/build-plugins.mjs` s'exécute sans erreur et régénère les commandes pour les 5 connecteurs.
2. `npm run qa` passe à 100% avec 0 échec.
3. `node src/bridge.mjs runs` affiche le dashboard Markdown structuré.
4. `node src/bridge.mjs adversarial-review --focus "security"` fonctionne et génère le prompt Red Team sans bloquer la lecture.
5. `node src/bridge.mjs rescue --prompt "fix bug"` s'exécute en mode écriture avec rollback Git.
6. `benchmarks/parallel-policy.json` configuré correctement.

Maintenez vos fichiers de suivi (`plan.md`, `progress.md`, `BRIEFING.md`) dans votre dossier de travail. Décomposez le travail et déléguez aux spécialistes appropriés. Quand l'implémentation et la vérification complète sont terminées, faites votre rapport final.
