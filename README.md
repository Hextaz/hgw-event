# 🏆 Hextaz Games Week (HGW) — `hgw.hextaz.dev`

Plateforme tout-en-un (**Site Web + Bot Discord.js + Cron + SQLite WAL + Parser Binaire/XML `.Replay.gbx` Trackmania**) conçue pour l'événement communautaire **Hextaz Games Week (HGW)**.

---

## ⚡ Architecture & Décisions Techniques (Spécification V1.3)

Conformément au document de cadrage (`docs/spec_zlan_event.md`) :

1. **Conteneur unique Node.js 22 + TypeScript (`D4` & `D5`)** :
   - Embarque **Express**, **Bot `discord.js` v14**, **`node-cron` (`0 3 * * *` `Europe/Paris`)** et **SQLite en mode `WAL`** dans un seul processus pour éliminer tout risque de verrouillage (`SQLITE_BUSY`) entre le site et le bot.
   - Bind strict sur `127.0.0.1:3000` dans `docker-compose.yml` (l'exposition publique HTTPS `hgw.hextaz.dev` via `cloudflared` reste opérée côté hôte sur `VM100`).
2. **Source unique de vérité des points (`points_ledger` — `D1` & `D3`)** :
   - Toutes les attributions de points sont journalisées et idempotentes (`source_ref` unique), ventilées entre **`async` (50% Semaine)** et **`live` (50% Week-end)**.
   - Suivi automatique du seuil de la **Grande Tombola (`≥ 300 pts`)**.
3. **Moteur de Défis Quotidiens Stratifié & Anti-Épuisement (`D10` + Correctif V1.3)** :
   - **Minimum 4 jeux cochés** par joueur + catégorie **🌐 Fil Rouge / Jeux Web Gratuits** incluse d'office.
   - **Tirage stratifié équitable** : chaque nuit à **03h00** (et dès la 1re sauvegarde du profil), le moteur tire **1 Facile (15 pts) + 1 Moyen (25 pts) + 1 Difficile (40 pts)** = **80 pts/jour potentiels garantis pour chaque joueur**, sur 3 jeux distincts en priorité.
   - **1 Reroll gratuit par jour** : permet à un joueur de relancer un défi `open` par jour tout en conservant la même difficulté.
   - **Catalogue enrichi à 66 quêtes** (6 quêtes équilibrées par jeu) + fallback anti-épuisement sur les quêtes `expired` en fin de semaine si nécessaire.
   - **Cap strict de 5 défis validés/soumis par jeu et par semaine**.
4. **Vérificateur Automatique Trackmania `.Replay.gbx` Blindé (`Section 4.4`)** :
   - Vérifie l'entête binaire `GBX` (`0x47 0x42 0x58`, version ≥ 6) et la présence du payload fantôme binaire après le bloc `<header>` XML.
   - **Anti-partage de fichier** : calcul de l'empreinte **SHA-256** complète du binaire `.gbx` (`UNIQUE` en base).
   - **Liaison automatique du `tmnf_login`** au 1er dépôt pour empêcher l'upload du replay d'un autre joueur.
   - **Calcul différentiel non-cumulatif** sur les 8 maps Médailles (passer d'Argent `10 pts` à Auteur `30 pts` crédite uniquement `+20 pts`).
   - **Classement dynamique Top 10** au millième (`0:41.890`) sur la Map de la Semaine (`150 / 110 / 80 / 50 / 30 pts`).
5. **Système de Chapeaux (Pool 1 / 2 / 3), Mode Révélation Stream & Calculateur Fall Guys (`Section 4.2` & `D7`/`D8`)** :
   - Attribution des **Chapeaux 1 (Tryhard) / 2 (Intermédiaire) / 3 (Chill)** et pointage **Check-in vocal** dans le Back-Office Admin.
   - Algorithme de **Snake Draft (Serpentin) pondéré** pour créer des équipes 3v3 ou 2v2 équilibrées en 1 clic, avec **animation de révélation en direct pour le stream** et publication automatique sur Discord.
   - **Calculateur officiel Fall Guys (5 Shows)** intégré : saisie des scores manche par manche (`Couronne = 10`, `Finaliste = 6`, `Qualifié M1 = 3`, `Éliminé = 1`) et attribution automatique du barème HGW (`200 / 140 / 90 / 50 / 25 pts`).

---

## 🚀 Déploiement sur `VM100` (`/opt/homelab/hgw-event`)

```bash
git clone https://github.com/Hextaz/hgw-event.git /opt/homelab/hgw-event
cd /opt/homelab/hgw-event
cp .env.example .env
# Éditer .env avec vos identifiants Discord OAuth2 / Bot Token / Admin IDs
docker compose up -d --build
```

## 🏎️ Déploiement du Serveur Trackmania Nations Forever + `playit.gg` (LXC Debian 12 sur `pve`)

Dans le conteneur LXC Debian 12 dédié :

```bash
chmod +x infra/tmnf-lxc-setup.sh
./infra/tmnf-lxc-setup.sh
```

## 🧪 Développement Local & Tests Automatisés

```bash
npm install
npm test        # Exécute la suite de tests (Tirage 7 jours, Reroll, Parser .gbx, Chapeaux, Fall Guys)
npm run dev     # Lance le serveur sur http://127.0.0.1:3000 avec le mode Démo activé
```
