#!/usr/bin/env bash
# ==============================================================================
# HEXTAZ GAMES WEEK (HGW) — Provisioning Serveur TMNF + playit.gg (LXC Debian 12)
# Décision D6 : Serveur dédié Trackmania Nations Forever (port 2350 TCP+UDP)
# ==============================================================================
set -euo pipefail

echo "[1/6] Installation des dépendances 32-bit (requises par TrackmaniaServer_2011-02-21) & playit.gg..."
dpkg --add-architecture i386
apt-get update
apt-get install -y libc6:i386 libstdc++6:i386 curl unzip ca-certificates gnupg

echo "[2/6] Ajout du dépôt officiel playit.gg..."
curl -SsL https://playit-cloud.github.io/ppa/key.gpg | gpg --dearmor | tee /etc/apt/trusted.gpg.d/playit.gpg >/dev/null
echo "deb [signed-by=/etc/apt/trusted.gpg.d/playit.gpg] https://playit-cloud.github.io/ppa/data ./" | tee /etc/apt/sources.list.d/playit-cloud.list
apt-get update
apt-get install -y playit

echo "[3/6] Création de l'utilisateur non-privilégié tmnf..."
if ! id -u tmnf >/dev/null 2>&1; then
  useradd -m -s /bin/bash tmnf
fi

mkdir -p /opt/tmnf
chown -R tmnf:tmnf /opt/tmnf

echo "[4/6] Téléchargement du binaire TrackmaniaServer_2011-02-21..."
cd /opt/tmnf
if [ ! -f /opt/tmnf/TrackmaniaServer ]; then
  su - tmnf -c "cd /opt/tmnf && curl -L -o tmnf_server.zip http://files.trackmaniaforever.com/TrackmaniaServer_2011-02-21.zip && unzip -o tmnf_server.zip && chmod +x TrackmaniaServer"
fi

echo "[5/6] Génération des profils MatchSettings (TimeAttack Semaine & Cup Samedi 12 courses max)..."
mkdir -p /opt/tmnf/GameData/Tracks/MatchSettings

cat <<'EOF' > /opt/tmnf/GameData/Tracks/MatchSettings/hgw_weekly_timeattack.txt
<?xml version="1.0" encoding="utf-8" ?>
<playlist>
  <gameinfos>
    <game_mode>1</game_mode> <!-- 1 = TimeAttack -->
    <chat_time>10000</chat_time>
    <finishtimeout>1</finishtimeout>
    <timeattack_limit>600000</timeattack_limit> <!-- 10 min par rotation sur la même map -->
    <timeattack_synchstartperiod>0</timeattack_synchstartperiod>
  </gameinfos>
  <filter>
    <is_lan>0</is_lan>
    <is_internet>1</is_internet>
    <random_map_order>0</random_map_order>
  </filter>
  <challenge>
    <file>Challenges/My Challenges/HGW_Weekly.Challenge.Gbx</file>
  </challenge>
</playlist>
EOF

cat <<'EOF' > /opt/tmnf/GameData/Tracks/MatchSettings/hgw_saturday_cup.txt
<?xml version="1.0" encoding="utf-8" ?>
<playlist>
  <gameinfos>
    <game_mode>5</game_mode> <!-- 5 = Cup Mode (Samedi 21h00-21h30, 12 courses max) -->
    <chat_time>8000</chat_time>
    <finishtimeout>15000</finishtimeout>
    <cup_pointslimit>100</cup_pointslimit>
    <cup_roundsperchallenge>3</cup_roundsperchallenge>
    <cup_nbwinners>3</cup_nbwinners>
    <cup_warmupduration>1</cup_warmupduration>
  </gameinfos>
  <filter>
    <is_lan>0</is_lan>
    <is_internet>1</is_internet>
    <random_map_order>0</random_map_order>
  </filter>
  <challenge><file>Challenges/Nadeo/A01-Race.Challenge.Gbx</file></challenge>
  <challenge><file>Challenges/Nadeo/A06-Obstacle.Challenge.Gbx</file></challenge>
  <challenge><file>Challenges/Nadeo/B02-Race.Challenge.Gbx</file></challenge>
  <challenge><file>Challenges/Nadeo/C04-Race.Challenge.Gbx</file></challenge>
</playlist>
EOF

chown -R tmnf:tmnf /opt/tmnf/GameData

echo "[6/6] Création du service systemd tmnf.service..."
cat <<'EOF' > /etc/systemd/system/tmnf.service
[Unit]
Description=Hextaz Games Week — Trackmania Nations Forever Dedicated Server
After=network.target

[Service]
Type=forking
User=tmnf
WorkingDirectory=/opt/tmnf
ExecStart=/opt/tmnf/TrackmaniaServer /game_settings=MatchSettings/hgw_weekly_timeattack.txt /dedicated_cfg=dedicated_cfg.txt /internet
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
echo "✅ Provisioning terminé !"
echo "👉 Étape 1 : Éditer /opt/tmnf/GameData/Config/dedicated_cfg.txt avec votre login/password serveur TMNF (<server_port>2350</server_port>)."
echo "👉 Étape 2 : Lancer 'systemctl enable --now playit' puis 'playit setup' et créer un tunnel TCP+UDP vers 127.0.0.1:2350."
echo "👉 Étape 3 : Lancer 'systemctl enable --now tmnf.service'."
