# CONTEXT.md — gabarit

> Cible : 20 lignes max dans le fichier final. Ce gabarit est plus long que le
> résultat attendu — il liste ce qu'il faut savoir, pas ce qu'il faut écrire.

---

## Le fichier final

```markdown
# CONTEXT

Stack : <langage, framework, versions qui comptent>
Lancer : <commande>
Tester : <commande> (+ prérequis : DB, seed, service externe ?)

Point d'entrée debug : <le fichier par lequel on commence, pas le main>
Zones actives : <2-3 dossiers où le travail se passe réellement>
Zones mortes : <ce qui existe mais ne doit pas être touché ni lu>

Pièges :
- <piège 1 — celui qui t'a déjà coûté une heure>
- <piège 2>
- <piège 3>

Interdits : <ce qu'on ne modifie jamais sans accord>
```

---

## Ce que l'agent remplit seul — [OBS]

À ne PAS demander, c'est dans le repo :
stack et versions, scripts de lancement et de test, arborescence,
gestionnaire de paquets, config CI, linter et formateur, présence de tests.

---

## Lot 1 — Réalité d'exécution

Ce que les scripts déclarent n'est pas ce qui marche.

1. La commande de test du package.json passe-t-elle réellement aujourd'hui ?
2. Faut-il quelque chose de lancé à côté (DB, Docker, service externe, tunnel) ?
3. Y a-t-il une étape d'init non documentée (seed, .env, migration, build préalable) ?
4. Des tests sont-ils cassés en permanence et ignorés ?

## Lot 2 — Topographie réelle

Ce que le code ne dit pas sur lui-même.

1. Quand un bug arrive, par quel fichier commences-tu, dans les faits ?
2. Quels dossiers concentrent 90 % du travail en cours ?
3. Qu'est-ce qui est mort, déprécié ou en cours de remplacement — mais toujours présent ?
4. Qu'est-ce qui a l'air central mais ne l'est pas (piège de nommage) ?
5. Y a-t-il du code généré à ne jamais éditer à la main ?

## Lot 3 — Pièges et interdits

Le lot le plus rentable. Ce sont des faits que tu es seul à connaître.

1. Qu'est-ce qui t'a déjà coûté plus d'une heure sur ce projet ?
2. Quelle erreur revient et dont la cause n'est jamais celle qu'on croit ?
3. Qu'est-ce qui casse en silence, sans message clair ?
4. Qu'est-ce qu'on ne modifie jamais sans ton accord explicite ?
5. Y a-t-il une convention non écrite qu'un nouvel arrivant enfreint systématiquement ?

## Lot 4 — Optionnel, seulement si pertinent

1. Un choix technique surprenant qui a une raison, et laquelle ?
2. Une contrainte externe qui dicte l'architecture (client, legacy, réglementaire) ?
3. Ce projet partage-t-il du code ou des conventions avec un autre des tiens ?

---

## Règle de coupe

Si le fichier dépasse 20 lignes, on garde par ordre de priorité :
pièges > point d'entrée debug > commandes réelles > zones mortes > le reste.

Un CONTEXT.md de deux pages est lu en diagonale par le modèle
et noyé dans le contexte. C'est le défaut qu'on cherche à éviter.
