# Commande `/code-review` - Revue de Code Intransigeante (Staff Engineer)

Déclenche l'audit sur : `$ARGUMENTS`.

## Instructions pour Claude / Antigravity :

1. **Périmètre** :
   * `--full` : audit architectural global du dépôt.
   * Un chemin de fichier (ex: `src/featured.ts` ou `public/admin.js`) : ce fichier et ses dépendances directes.
   * Vide ou `--diff` : modifications courantes (diff de la branche vs `main`).
2. **Charge la source unique** : lis `.agents/skills/code-reviewer/SKILL.md`, exécute son diagnostic préalable (`npm run build`, `npm test`, `node --check public/shared.js public/app.js public/admin.js`, scans `rg` des anti-patterns) et évalue les 6 piliers.
3. **Restitution** : suis exactement le format de rapport du `SKILL.md` — scorecard /100, anomalies préfixées `AUD-`, matrice effort/impact, plan de remédiation par scope (pas de « prompts à copier »).
