---
name: issue-ritual
version: "1.0.0"
description: Rituel d'exécution obligatoire pour Claude Code et Antigravity lors de la résolution de toute issue sur HGW Event. Comprend le cadrage Git initial, la présentation d'un plan d'implémentation à valider avant de coder, le TDD strict avec Verify RED, la couverture des cas limites (SQLite WAL, migrations V1→V2, concurrence Web/Discord, GBX), la checklist de sécurité (auth, RBAC, XSS Vanilla JS, uploads, webhook), la loi d'airain anti-bandaids, le protocole Evidence Before Claims (tsc, npm test, node --check), et un bilan final sans commit automatique.
allowed-tools: "Read Write Edit Grep Glob Bash(git status:*) Bash(git diff:*) Bash(git log:*) Bash(git branch:*) Bash(git checkout:*) Bash(gh issue view:*) Bash(gh issue list:*) Bash(gh pr view:*) Bash(npm test:*) Bash(npm run build:*) Bash(npx tsc:*) Bash(node --check:*) Bash(rg:*)"
metadata:
  no-auto-commit: true
---

# 🥋 Rituel de Résolution d'Issue - HGW Event

Ce rituel structure le travail de l'agent en **5 phases rigoureuses**. Il impose un **point d'arrêt obligatoire (Gate d'approbation)** après la récolte d'informations pour valider le plan avec l'utilisateur, applique une **discipline d'ingénierie d'élite (TDD, Anti-Band-Aids, Evidence Before Claims)**, et **interdit formellement tout commit automatique**.

---

## 🧭 Vue d'ensemble du Déroulement

```
┌─────────────────────────────────────────┐
│ PHASE 1 : Cadrage & Récolte d'Infos    │ ➜ Git context, gh issue view, DB/config inspection, surface sécu/XSS
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 2 : 🛑 RÉCAPITULATIF & PLAN       │ ➜ Présenter le plan et attendre le feu vert explicite !
└────────────────────┬────────────────────┘
                     ▼ (Validation utilisateur)
┌─────────────────────────────────────────┐
│ PHASE 3 : Implémentation & TDD Strict   │ ➜ TDD Verify RED ➜ Sécurité ➜ Anti-Band-Aids ➜ DB ➜ Domaine ➜ API/Bot ➜ Front
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 4 : 🧪 Porte de Vérification      │ ➜ npm run build + npm test + node --check + preuve cas limites + sécu
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 5 : Bilan Final (Zéro Auto-Commit)│ ➜ Diff propre, mini-rapport 5 lignes, commande commit prête
└─────────────────────────────────────────┘
```

---

## 📍 PHASE 1 : Cadrage & Collecte d'Informations (Ne jamais coder à l'aveugle)

### 1.1 Contexte Git & État de la Branche (CRUCIAL)
Avant toute analyse, vérifier où l'on se trouve pour ne pas écraser de travail ou polluer l'historique :
```bash
# 1. Quelle est la branche active ?
git branch --show-current

# 2. Quels sont les commits déjà présents sur cette branche par rapport à main ?
git log main..HEAD --oneline

# 3. Y a-t-il des modifications en cours non commitées ?
git status --short
git diff
```
* **Vérifications clés** :
  * Si la branche est `main`, alerter l'utilisateur et recommander la création d'une branche dédiée : `git checkout -b feat/issue-<NUMERO>` (ou `fix/issue-<NUMERO>`).
  * Si des commits existent déjà sur la branche (`git log main..HEAD`), en prendre connaissance pour **ne pas réécrire ou réinventer ce qui a déjà été fait**.
  * Si des fichiers sont déjà modifiés/non commités (`git status`), les analyser pour distinguer ce qui relève du ticket en cours d'éventuels résidus d'une autre session.

### 1.2 Lire le ticket complet
```bash
gh issue view <NUMERO> --json number,title,body,labels
```
* Extraire les spécifications fonctionnelles, les fichiers cibles et les critères d'acceptation.
* Identifier la complexité et la priorité (P0, P1, P2).

### 1.3 Inspecter l'état réel du codebase
1. **Recherche de symboles existants** :
   ```bash
   rg "nomDuSymboleOuModele" src/ public/ test/
   ```
2. **Vérité Base de Données & Migrations (`src/db.ts`, `src/seed.ts`)** :
   * Inspecter `src/db.ts` pour connaître les tables, colonnes, contraintes `CHECK`/`UNIQUE`/`FOREIGN KEY` et migrations existantes.
   * Vérifier si une base SQLite existante (V1 ou édition précédente) doit migrer sans perte de données.
   * Vérifier que le seed reste non destructif (`catalog_seeded`, `featured_seeded`, `tournaments_seeded`).
3. **Vérité Configuration Modulaire (`src/config.ts`)** :
   * Toute règle d'édition (actes 1..3, phase `draft`, barèmes, jeu vedette `tmnf_gbx`/`standard`/désactivé, lots) provient de `event_config`, jamais de constantes figées.
4. **Surface de Sécurité** :
   * Le ticket touche-t-il une route Express (`src/index.ts`), une interaction Discord (`src/bot.ts`), un upload (`multer`), le parser GBX (`src/gbx.ts`), une requête SQL, une variable d'environnement ou du rendu HTML dans `public/` ?
   * Identifier explicitement les protections requises : `requireAuth` / `requireAdmin`, anti-IDOR, échappement XSS (`escHtml`), validation d'URL (`https://`), comparaison en temps constant (`timingSafeEqual`), atomicité transactionnelle.
5. **Surface Front Vanilla JS (`public/`)** :
   * Repérer les helpers partagés dans `public/shared.js`, la vue joueur (`public/app.js`), le back-office (`public/admin.js`), `public/index.html`, `public/overlay.html` et les tokens CSS `hgw-*` dans `public/styles.css`.

---

## 🛑 PHASE 2 : Récapitulatif & Validation du Plan (POINT D'ARRÊT OBLIGATOIRE)

> [!IMPORTANT]
> **Ne modifier AUCUN fichier de code avant d'avoir présenté ce récapitulatif et obtenu la confirmation explicite de l'utilisateur.**

L'agent doit produire un bilan clair structuré comme suit :
1. **🌿 Contexte Git** : Branche active, commits déjà existants pris en compte, statut des modifications locales en cours.
2. **🎯 Objectif & Périmètre** : Résumé en 2-3 phrases de ce que le ticket accomplit.
3. **📂 Fichiers impactés** : Liste ordonnée des fichiers à modifier ou créer.
4. **🗄️ Impact Base de Données & Migrations** : Évolutions de schéma SQLite dans `src/db.ts` (oui/non) et compatibilité ascendante avec une base existante.
5. **⚠️ Cas limites & Pièges identifiés** : Penser systématiquement à : phase `draft` (masquage joueur), 1 à 3 actes, 0 jeu vedette, double-clic / validation simultanée Web + Discord `#preuves`, fichier `.gbx` corrompu ou doublon SHA-256/`tmnf_login`, nombres impairs en tirage chapeaux, valeurs nulles / `NaN` / négatives, bot Discord désactivé (sans token).
6. **🔒 Impact Sécurité** : Routes ou interactions touchées, `requireAuth`/`requireAdmin`, anti-IDOR, échappement XSS (`public/`), validation des entrées/uploads, secrets. Écrire *« Aucun impact sécurité »* explicitement si c'est le cas.
7. **🧪 Stratégie de tests & TDD** : Scénarios ajoutés dans `test/engine.test.ts` (ou fichier de test dédié), **un scénario par cas limite annoncé** au point 5, plus les chemins de refus/erreur.
8. **❓ Questions / Arbitrages éventuels** (si ambiguïté subsistante).
9. **Demande explicite** : *"Ce plan te convient-il ? Dois-je commencer l'implémentation ?"*

---

## 💻 PHASE 3 : Implémentation Rigoureuse & Discipline d'Ingénierie

Appliquer les modifications dans l'ordre strict des dépendances de la plateforme :

```
1. src/db.ts            ➜ Schéma SQLite WAL & migrations douces idempotentes
2. src/config.ts        ➜ Types de configuration d'édition, validation & valeurs par défaut
3. src/{gbx,engine,featured,tournaments,catalog,editions,seed}.ts
                        ➜ Logique métier pure & accès SQLite transactionnel (TDD strict !)
4. src/bot.ts           ➜ Commandes slash, modération #preuves & annonces Discord
5. src/index.ts         ➜ Routes REST Express, auth/RBAC, uploads, webhooks & cron
6. public/{shared,app,admin}.js, index.html, overlay.html, styles.css
                        ➜ UI Vanilla JS sécurisée (XSS-safe) & design system hgw-*
7. test/engine.test.ts  ➜ Tests automatisés (comportement réel + cas limites + migrations)
```

### 3.0 — Discipline d'Ingénierie & TDD Strict

- **TDD strict pour la logique métier, le parser GBX, les calculs de points et les migrations** :
  1. *RED* : Écrire le test minimal décrivant le comportement attendu avant le code métier.
  2. *VERIFY RED (Obligatoire)* : Exécuter `npm test` et **constater l'échec pour la raison attendue**. Un test qui passe immédiatement ne prouve rien.
  3. *GREEN* : Écrire le code minimal strict pour satisfaire le test.
  4. *VERIFY GREEN* : Ré-exécuter `npm test` et vérifier le passage au vert.
  5. *REFACTOR* : Factoriser et nettoyer en restant vert.

- **Tests des cas limites, pas seulement du happy path** :
  - Chaque cas limite listé en Phase 2 est couvert par des assertions explicites sur l'état réel en SQLite (`points_ledger`, contraintes, statuts, réponses).
  - Pour tout contrôle de sécurité, d'anti-triche ou d'idempotence ajouté : tester le chemin **refusé** (doublon, statut déjà traité, entrée invalide, utilisateur non autorisé) autant que le chemin accepté.

- **Loi d'Airain Anti-Symptôme (Anti-Band-Aids & Anti-`any`)** :
  - **Aucune modification de code sans avoir formellement identifié et prouvé la cause racine.**
  - **Interdiction formelle de poser une rustine pour faire taire le compilateur ou masquer une erreur** : pas de `?.` sauvage, pas de `try/catch` vide qui avale les exceptions en silence, pas de fallback magique (`?? null` / `|| 0`) masquant un état incohérent.
  - **Interdiction formelle d'utiliser `any`** ou des assertions abusives (`as any`, `as unknown as ...`).

### 3.1 — Règles de Code & Garde-Fous Techniques

- **TypeScript strict (`tsconfig.json`)** :
  - `strict: true`, ESM `NodeNext` (extensions `.js` sur les imports relatifs dans `src/`).
  - Typer explicitement les lignes retournées par `better-sqlite3` et valider les payloads HTTP à la frontière.
- **SQLite WAL & Atomicité (`better-sqlite3`)** :
  - Toute opération modifiant plusieurs tables ou lisant-puis-modifiant un état critique DOIT être encapsulée dans `db.transaction(() => { ... })()`.
  - Requêtes strictement paramétrées (`?`). Jamais d'interpolation de valeurs utilisateur dans une chaîne SQL.
  - Idempotence des validations : utiliser un `UPDATE ... WHERE id = ? AND status = 'pending'` et vérifier `result.changes === 1` avant de créditer `points_ledger`.
- **Front Vanilla JS (`public/`)** :
  - **Zéro XSS** : toute donnée dynamique injectée dans `innerHTML` ou dans un attribut HTML passe impérativement par l'échappement (`escHtml` / `escapeHtml`) ou `textContent`.
  - **URLs sûres** : filtrer toute URL cliquable ou image (`https://` ou chemin relatif attendu) — jamais de `javascript:` injectable dans `href` ou `src`.
  - **États d'interface** : gérer chargement, erreur utilisateur claire (toast/banner, pas de `window.alert()` bloquant) et état vide accueillant.
  - **Propreté des timers/listeners** : nettoyer les `setInterval` / `setTimeout` et éviter d'empiler des `addEventListener` à chaque re-render.
  - **Respect du design system `hgw-*`** (`public/styles.css`).
- **Checklist Sécurité (non négociable)** :
  - **Auth & RBAC** : `requireAdmin` sur chaque route `/api/admin/*` ; `requireAuth` + vérification d'appartenance (anti-IDOR) sur les routes joueur.
  - **Discord** : vérifier les permissions admin réelles sur les interactions `#preuves` et commandes admin ; gérer gracieusement les salons/messages supprimés.
  - **Mode démo** : `ALLOW_DEV_LOGIN` fermé par défaut en `NODE_ENV=production`.
  - **Webhook & Secrets** : comparaison `crypto.timingSafeEqual` sur `TMNF_WEBHOOK_SECRET` et signatures HMAC ; zéro secret dans les réponses publiques (`/api/state`, `/api/config`), le front ou les logs.
  - **Uploads** : limites de taille, extensions/MIME autorisés (SVG refusé pour les logos), noms générés côté serveur, protection anti path-traversal sur les chemins résolus.

---

## 🧪 PHASE 4 : Porte de Vérification (« Evidence Before Claims »)

> [!CAUTION]
> **Interdiction formelle d'affirmer qu'une tâche est terminée, qu'un bug est résolu ou que le code compile sans en apporter la preuve terminale fraîche.**

Exécuter et afficher les résultats des commandes suivantes (sans mode watch) :

```bash
# 1. Compilation & vérification TypeScript stricte (0 erreur)
npm run build

# 2. Suite de tests automatisés (0 échec, code de sortie 0)
npm test

# 3. Vérification syntaxique du front Vanilla JS
node --check public/shared.js && node --check public/app.js && node --check public/admin.js
```

Si l'une des commandes échoue, corriger immédiatement à la racine avant de continuer.

**4. Preuve des cas limites** : pour chaque cas limite annoncé en Phase 2, citer le test qui le couvre et confirmer son passage dans la sortie de `npm test`.

**5. Auto-contrôle sécurité** : si le diff touche `src/index.ts`, `src/bot.ts`, `src/gbx.ts`, `src/db.ts`, `public/` ou `.env.example`, relire le diff au prisme du pilier Sécurité de `.agents/skills/code-reviewer/SKILL.md` (ou lancer `/code-review --diff`). Toute faille 🔴 bloque la clôture.

---

## 📦 PHASE 5 : Bilan Final & Clôture (PAS D'AUTO-COMMIT)

> [!CAUTION]
> **Interdiction formelle d'exécuter `git commit` automatiquement.**
> Le commit appartient à l'utilisateur. L'agent prépare le terrain, audite la propreté du diff, et fournit la commande de commit prête à copier.

### 5.1 Audit de propreté du Diff
```bash
git status
git diff --stat
```
* **Nettoyage strict** : Aucun `console.log("DEBUG", ...)` résiduel, aucun fichier temporaire, aucun `.db` / `.env` non ignoré, aucun code mort, aucun `any` introduit.

### 5.2 Mini-Rapport de Clôture (5 lignes max)
Terminer systématiquement par un rapport dense et percutant :
1. **Fichiers modifiés** : Liste synthétique des fichiers backend, front et tests touchés.
2. **Preuves terminales validées** : `npm run build` (Succès), `npm test` (OK), `node --check public/*.js` (OK).
3. **Cas limites & sécurité** : Cas limites couverts par les tests et résultat de l'auto-contrôle sécurité (ou « aucun impact »).
4. **Test local** : Commande pour tester (`npm run dev`, serveur sur `http://127.0.0.1:3000`).
5. **Commande de commit** :
   ```bash
   git add <fichiers concernés>
   git commit -m "<type>(<scope>): <description claire> (#<NUMERO>)"
   # Pousser la branche de travail, puis ouvrir ou mettre à jour la PR. Aucun déploiement implicite.
   git push origin HEAD
   ```
   * **Suivi de mise en production** : uniquement si un déploiement a été demandé, vérifier la CI GHCR et l'état du service dans l'environnement autorisé. Conserver les coordonnées d'exploitation hors des consignes publiques.
