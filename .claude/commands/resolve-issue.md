# Commande `/resolve-issue` - Rituel de Résolution d'Issue

Applique le rituel complet pour l'issue : `$ARGUMENTS`.

## Instructions pour Claude / Antigravity :

1. **Vérification de l'argument** : `$ARGUMENTS` doit être un numéro d'issue GitHub (ex: `12` ou `#12`). Sinon, demande-le poliment à l'utilisateur.
2. **Charge la source unique** : lis `.agents/skills/issue-ritual/SKILL.md` et applique ses 5 phases à la lettre :
   cadrage Git & issue → récapitulatif & plan avec **validation explicite de l'utilisateur** → implémentation TDD strict → porte de vérification (`npm run build`, `npm test`, `node --check public/*.js`, sécurité) → bilan final **sans jamais exécuter `git commit`**.
3. **Ne duplique aucune règle ici** : toute modification du rituel se fait uniquement dans le `SKILL.md` (avec bump de `version`).
