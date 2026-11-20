# 🏆 Hextaz Games Week (HGW) — `hgw.hextaz.dev`

Plateforme tout-en-un (**Site Web + Bot Discord.js + Cron + SQLite WAL + Parser Binaire/XML `.Replay.gbx` Trackmania + Overlay OBS**) conçue pour l'événement communautaire **Hextaz Games Week (HGW — Édition 2 Semaines)**.

---

## ⚡ Architecture & Fonctionnalités (V3.1 — Format 2 Semaines)

Conformément aux documents de cadrage ([`docs/spec_zlan_event.md`](docs/spec_zlan_event.md) et [`docs/annonce_discord_hgw.md`](docs/annonce_discord_hgw.md)) :

1. **Conteneur unique Node.js 22 + TypeScript (`D4` & `D5`)** :
   - Embarque **Express**, **Bot `discord.js` v14**, **`node-cron` (`0 3 * * *` `Europe/Paris`)** et **SQLite en mode `WAL`** dans un seul processus pour éliminer tout risque de verrouillage (`SQLITE_BUSY`) entre le site et le bot.
   - Bind strict sur `127.0.0.1:3000` dans `docker-compose.yml` (l'exposition publique HTTPS `hgw.hextaz.dev` via `cloudflared` reste opérée côté hôte sur `VM100`).
2. **Phasage sur 2 Semaines (Acte I $\rightarrow$ Acte II $\rightarrow$ Week-end Final Live)** :
   - **Semaine 1 — Acte I (J1 à J7)** : Défis Quotidiens S1 (`4 défis max/jeu`) + **Chasse aux 8 Maps Médailles Solo TMNF (`240 pts` max)**. La Map Serveur 24/7 est verrouillée en Semaine 1.
   - **Semaine 2 — Acte II (J8 à J12)** : **🔓 Déblocage automatique de la Map Serveur 24/7 TMNF (`150 pts` au 1er)** + **11 nouveaux défis `[Acte II]`** + **Reset automatique du quota hebdomadaire par jeu** (`4 nouveaux défis/jeu`, soit `8 défis/jeu` sur la quinzaine).
   - **Dernier Week-end — Finale Live (J13 & J14)** : Les **4 Grands Tournois Live** (Brawlhalla, Cup TMNF, RL Rumble, Fall Guys 5-Show) + **Grande Tombola (`≥ 300 pts`)**.
3. **Moteur de Défis Quotidiens Stratifié & Bonus de Régularité (`D10`)** :
   - **Minimum 4 jeux cochés** par joueur + catégorie **🌐 Fil Rouge / Jeux Web Gratuits** incluse d'office.
   - **Tirage stratifié équitable** : chaque nuit à **03h00**, le moteur tire **1 Facile (`10 pts`) + 1 Moyen (`15 pts`) + 1 Difficile (`25 pts`)** = **`50 pts/jour` potentiels garantis** (`600 pts` sur 12 jours).
   - **🔥 Bonus de Régularité Automatique (Assiduité)** : valider au moins 1 défi par jour crédite automatiquement des paliers bonus dans `points_ledger` : **4 jours actifs (`+20 pts`)**, **8 jours actifs (`+40 pts`)**, **12 jours actifs (`+60 pts`)** soit jusqu'à **`+120 pts` bonus**.
   - **1 Reroll gratuit par jour** + **Catalogue de 77 quêtes** (66 quêtes Acte I + 11 quêtes Acte II).
4. **Vérificateur Automatique Trackmania `.Replay.gbx` Blindé & Dépôt Multi-Fichiers (`Section 4.4`)** :
   - **Upload en lot (Batch Drag & Drop)** : dépôt simultané de plusieurs fichiers `.Replay.gbx` d'un coup.
   - Vérifie l'entête binaire `GBX` (`0x47 0x42 0x58`, version ≥ 6) et la présence du payload fantôme binaire après le bloc `<header>` XML.
   - **Anti-triche & Anti-partage** : empreinte **SHA-256** unique + **unicité inter-joueurs du `tmnf_login`** (deux comptes Discord ne peuvent pas partager le même compte Trackmania).
   - **Classement par piste & Téléchargement du Ghost `.gbx`** : modale dédiée par map avec écarts au WR (`+0.xxx`) et téléchargement du replay fantôme pour s'entraîner contre le leader.
   - **Webhook Live Serveur TMNF (`/api/tmnf/webhook/finish`)** : remontée automatique en temps réel des chronos réalisés sur le serveur dédié.
5. **Outils Streamer, Chapeaux & Back-Office Admin Complet** :
   - **Overlay OBS Transparent (`/overlay.html`)** : Browser Source `1920x1080` temps réel (Top 5 HGW, Record Serveur TMNF, Ticker d'activité, mode compact `?compact=1`).
   - **Show Stream Plein Écran** : Révélation dramatique des équipes équilibrées (**Chapeaux 1 / 2 / 3** en Snake Draft) + **Roue de la Grande Tombola animée** pour le dimanche 18h.
   - **Sauvegarde à chaud SQLite (`/api/admin/backup/sqlite`)**, export JSON complet et journal d'audit horodaté.

---

## 🎨 Design system

L'interface suit le design system HGW v2 (thème sombre unique, or réservé aux points et à l'action principale, icônes au trait, chiffres en JetBrains Mono). Les tokens et composants `hgw-*` vivent dans `public/styles.css`.

- **Vues routées par URL** : `/` (Aujourd'hui), `/classement`, `/trackmania`, `/tournois`, `/aide`.
- **Back-office** : `/admin` (modération), `/admin/evenement`, `/admin/catalogue` (jeux et défis), `/admin/tournois`, `/admin/points`, `/admin/maintenance`.
- **Catalogue jeux & défis (`/admin/catalogue`)** : création, modification, archivage et suppression des jeux et des défis, avec un tableau de couverture par difficulté et par acte.
  - Les points suivent la difficulté (10 / 15 / 25) pour garantir les 50 pts/jour du tirage.
  - Un défi déjà tiré ne se supprime pas : il s'archive (l'historique et les points restent). Un jeu déjà utilisé se désactive.
  - Le catalogue de `src/seed.ts` n'est appliqué qu'au premier démarrage (`catalog_seeded`) : les modifications faites dans l'admin ne sont plus écrasées au redémarrage.
  - Logos : URL https, téléversement (PNG/JPEG/WEBP/GIF, 1 Mo, SVG refusé) ou recherche SteamGridDB si `STEAMGRIDDB_API_KEY` est défini. Les images importées sont hébergées dans `data/logos`.
- **Modération au clavier** : `V` valider, `R` refuser (puis `1`–`5` pour un motif), `→` passer, `Espace` agrandir. Chaque décision peut être annulée pendant 5 s.
- **Overlay OBS** : `/overlay.html?pos=tr&compact=1`.

## 🔒 Sécurité en production

- `ALLOW_DEV_LOGIN` doit rester à `false` : le mode démo (connexion de test, joueurs fictifs, replays d'exemple) est fermé par défaut quand `NODE_ENV=production`.
- `TMNF_WEBHOOK_SECRET` doit être défini, identique dans le bridge XML-RPC du serveur Trackmania.
- Définir un `SESSION_SECRET` long et aléatoire.

## 🚀 Déploiement sur `VM100` (`/opt/homelab/hgw-event`)

**Déploiement continu (décision actuelle)** : à chaque merge sur `main`, la CI (`.github/workflows/docker.yml`)
build l'image, la publie sur GHCR (`ghcr.io/hextaz/hgw-event:sha-<12>` puis tag mutable `:prod`) et le timer
systemd `hgw-event-rollout.timer` sur VM100 (toutes les 2 min) pull l'image `:prod` et la déploie via
`deploy/rollout.sh` (readiness `GET /api/state` + rollback auto). Installation initiale :

```bash
git clone https://github.com/Hextaz/hgw-event.git /opt/homelab/hgw-event
cd /opt/homelab/hgw-event
cp .env.example .env
# Éditer .env avec vos identifiants Discord OAuth2 / Bot Token / Admin IDs (chmod 600, jamais commité)
chown -R 1000:1000 data   # le conteneur tourne en user node (uid 1000) et écrit /data
docker compose up -d --build
sudo cp deploy/systemd/hgw-event-rollout.service deploy/systemd/hgw-event-rollout.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now hgw-event-rollout.timer
```

Mise à jour manuelle (si besoin) : `git pull && docker compose up -d --build`. En local/dev, sans
`HGW_IMAGE`, `docker compose up -d --build` construit et lance l'image locale `hgw-event-app`.

## 🏎️ Déploiement du Serveur Trackmania Nations Forever + `playit.gg` (LXC Debian 12 sur `pve`)

Dans le conteneur LXC Debian 12 dédié :

```bash
chmod +x infra/tmnf-lxc-setup.sh
./infra/tmnf-lxc-setup.sh
```

## 🧪 Développement Local & Tests Automatisés

```bash
npm install
npm test        # Exécute la suite de tests (Quinzaine 12j, Régularité, S1/S2 TMNF, Parser .gbx, Chapeaux, Fall Guys)
npm run dev     # Lance le serveur sur http://127.0.0.1:3000 (mode démo actif tant que DISCORD_CLIENT_ID est vide)
```
