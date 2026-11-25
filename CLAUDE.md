# HGW Event - Directives pour Claude Code & Antigravity

## 📌 Vue d'ensemble du Projet

**HGW Event** (Hextaz Games Week) est une plateforme communautaire multi-jeux tout-en-un combinant un serveur **Express + TypeScript**, un **Bot Discord.js v14**, un scheduler **`node-cron`**, une base **SQLite WAL (`better-sqlite3`)**, un **parser binaire/XML Trackmania GBX**, une interface web Vanilla JS (joueurs + back-office admin) et un **Overlay OBS**.

### Architecture du Dépôt
* **`src/db.ts`** : Initialisation SQLite en mode `WAL`, schéma relationnel et migrations douces idempotentes (V1 → V2+).
* **`src/config.ts`** : Configuration modulaire de l'édition (`event_config`), actes (1 à 3), phase `draft`, barèmes, jeu vedette et lots.
* **`src/engine.ts`** : Moteur de défis quotidiens stratifiés, rerolls, modération des preuves, bonus de régularité, classement et journal d'audit.
* **`src/featured.ts`** : Jeu vedette modulaire (`tmnf_gbx` ou `standard` avec métriques `time_asc` / `score_desc` / `binary`, Bloc A paliers, Bloc B ladder Top N et file de modération unifiée).
* **`src/gbx.ts`** : Parser binaire/XML `.Replay.gbx` & `.Challenge.gbx` (anti-triche SHA-256, payload fantôme, unicité `tmnf_login`).
* **`src/tournaments.ts`** : CRUD tournois du week-end, équipes dynamiques (`2v2`–`5v5`), chapeaux & Snake Draft, retouche en live et scoring `direct` / `rounds`.
* **`src/catalog.ts`** : CRUD jeux & défis, archivage/désactivation non destructive, export/import JSON et diagnostic de santé du catalogue.
* **`src/editions.ts`** : Archivage Hall of Fame (`/hall-of-fame`), cycle « Préparer une nouvelle édition » et gestion des droits administrateur.
* **`src/seed.ts`** : Seed initial non destructif (`catalog_seeded`, `featured_seeded`, `tournaments_seeded`).
* **`src/bot.ts`** : Bot Discord.js v14 (commandes slash, modération `#preuves` avec boutons ✅/❌, annonces).
* **`src/index.ts`** : Point d'entrée HTTP Express, auth Discord OAuth2 + cookies signés HMAC, RBAC (`requireAuth`/`requireAdmin`), uploads `multer`, webhook TMNF et cron (`0 3 * * *` `Europe/Paris`).
* **`public/`** : Frontend Vanilla JS (`shared.js`, `app.js`, `admin.js`), `index.html`, `overlay.html` et design system `hgw-*` (`styles.css`).
* **`test/engine.test.ts`** : Suite de tests automatisés exécutée sur base SQLite temporaire isolée (`npm test`).
* **`deploy/` & `infra/`** : Scripts de rollout Docker/systemd et bridge XML-RPC Trackmania.

---

## 🌐 Configuration propre à chaque instance

Les consignes publiques décrivent l'architecture et les commandes du projet. Les adresses d'administration, inventaires de services, secrets et procédures d'exploitation propres au mainteneur restent hors du suivi Git.

- Utiliser uniquement les environnements et services explicitement autorisés pour la tâche.
- Fournir les paramètres et secrets par `.env` / l'environnement de l'instance. Ne jamais placer de token dans une URL, un exemple versionné, un log ou un message GitHub.
- Analyser les diagnostics localement par défaut. Avant tout partage de logs, stack traces ou dumps, retirer les secrets et données personnelles.
- Ne pas déployer ni contacter la production pour une simple tâche de développement.

---

## 🛠️ Maintenance de cette Doc & des Skills (Source Unique)

* **`.agents/skills/*/SKILL.md` est la source unique** de chaque processus. `AGENTS.md`, `CLAUDE.md` et `.claude/commands/*.md` ne font que **pointer** vers les skills : ne jamais y recopier le contenu d'un skill (risque de divergence).
* Toute évolution d'un processus se fait dans le `SKILL.md` concerné, avec un **bump de `version`** dans son frontmatter.
* Les rapports d'audit préfixent leurs IDs d'anomalies par **`AUD-`** (`AUD-SEC-01`, `AUD-CON-01`…).
* Pas de sections « prompts prêts à copier » dans les skills : les correctifs se décrivent directement dans le rapport.
* `allowed-tools` dans le frontmatter d'un skill restreint les outils utilisables (ex : `issue-ritual` n'autorise aucun `git add` / `git commit` / `git push`).

---

## 🧭 Rituel Obligatoire pour Résoudre une Issue

> [!IMPORTANT]
> **Avant de toucher au code pour résoudre une issue, appliquer OBLIGATOIREMENT le Skill de rituel :**
> * **Skill complet (source unique)** : `.agents/skills/issue-ritual/SKILL.md` (accessible aussi via `.claude/skills/issue-ritual`)
> * **Commande rapide Claude Code** : `/resolve-issue <NUMERO>`

Le rituel en 5 phases — cadrage Git → récapitulatif & plan avec **validation utilisateur obligatoire** → implémentation TDD strict (Verify RED, anti-bandaids, sécurité) → porte de vérification « Evidence Before Claims » (`npm run build` / `npm test` / `node --check`) → bilan final **sans auto-commit** — est défini **uniquement** dans le `SKILL.md`. Ne pas recopier son contenu ici.

---

## 🧐 Code Reviewer Intransigeant (Skill d'Audit Staff Engineer)

Le dépôt intègre un skill d'audit complet pour évaluer le code avec un niveau d'exigence maximal (Architecture & SQLite, Sécurité & XSS, Perf & Concurrence, Clean Code, Typage & Contrats API, Tests) :
* **Skill complet (source unique)** : `.agents/skills/code-reviewer/SKILL.md` (accessible aussi via `.claude/skills/code-reviewer`)
* **Commandes rapides** :
  * `/code-review` : Audite le diff de la branche courante.
  * `/code-review --full` : Audite l'architecture globale du dépôt.
  * `/code-review <chemin/vers/fichier>` : Audite un fichier spécifique.

---

## 🛠️ Commandes Essentielles (Sans Watch)

Toujours exécuter les vérifications sans mode interactif/watch :

```bash
# 1. Compilation & vérification TypeScript stricte
npm run build
# ou typecheck seul :
npx tsc --noEmit

# 2. Suite de tests automatisés (SQLite WAL isolé dans /tmp)
npm test

# 3. Vérification syntaxique du front Vanilla JS
node --check public/shared.js && node --check public/app.js && node --check public/admin.js

# 4. Serveur local de développement (http://127.0.0.1:3000)
npm run dev
```

---

## 📐 Conventions Techniques HGW Event

1. **TypeScript & ESM (`tsconfig.json`)** : `strict: true`, `module: NodeNext` (toujours inclure l'extension `.js` sur les imports relatifs dans `src/`), zéro `any` ou `as unknown as` non justifié.
2. **SQLite WAL (`better-sqlite3`)** : mutations multi-tables dans `db.transaction(...)`, requêtes 100 % paramétrées (`?`), migrations douces idempotentes dans `src/db.ts`, seed non destructif dans `src/seed.ts`.
3. **Configuration Modulaire** : zéro hardcoding d'édition ; tout paramètre d'édition (actes, phase `draft`, barèmes, jeu vedette, tournois) provient de `src/config.ts` / SQLite.
4. **Sécurité & XSS** : `requireAuth` / `requireAdmin` + anti-IDOR, `ALLOW_DEV_LOGIN` fermé en prod, `timingSafeEqual` sur secrets/signatures, échappement systématique (`escHtml` / `escapeHtml`) dans tout `innerHTML` sous `public/` et validation stricte des URLs (`https://`).
5. **Concurrence Web + Discord** : toute validation de preuve/soumission vérifie atomiquement le passage depuis `'pending'` (`changes === 1`) avant de créditer `points_ledger`.

---

## 🐙 Conventions de Commits & PR

* Appliquer la convention **Conventional Commits** :
  * `feat(scope): description`
  * `fix(scope): description`
  * `ux(scope): description`
  * `refactor(scope): description`
  * `test(scope): description`
  * `chore(scope): description`
* Mentionner le numéro d'issue GitHub associé lorsqu'il existe (ex : `#12`).
