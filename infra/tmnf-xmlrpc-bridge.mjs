#!/usr/bin/env node
/**
 * ==============================================================================
 * HEXTAZ GAMES WEEK (HGW) — Bridge Temps Réel Serveur Trackmania (GBXRemote 2)
 * ==============================================================================
 * Se connecte en local au port XML-RPC (5000) de `TrackmaniaServer_2011-02-21`,
 * écoute les événements `TrackMania.PlayerFinish` et `TrackMania.BeginChallenge`,
 * et pousse instantanément chaque chrono vers `POST /api/tmnf/webhook` sur HGW.
 *
 * Résultat : dès qu'un joueur franchit la ligne d'arrivée sur le serveur dédié,
 * son temps, ses médailles et le Classement Général se mettent à jour en direct
 * sur `hgw.hextaz.dev` sans même avoir besoin d'uploader un fichier .Replay.gbx !
 */

import net from 'node:net';

const XMLRPC_HOST = process.env.TMNF_XMLRPC_HOST || '127.0.0.1';
const XMLRPC_PORT = Number(process.env.TMNF_XMLRPC_PORT || 5000);
const SUPERADMIN_USER = process.env.TMNF_SUPERADMIN_USER || 'SuperAdmin';
const SUPERADMIN_PASS = process.env.TMNF_SUPERADMIN_PASS || 'SuperAdmin';
const HGW_WEBHOOK_URL = process.env.HGW_WEBHOOK_URL || 'https://hgw.hextaz.dev/api/tmnf/webhook';
const TMNF_WEBHOOK_SECRET = process.env.TMNF_WEBHOOK_SECRET || '';
const DEFAULT_MAP_UID = process.env.TMNF_WEEKLY_MAP_UID || 'HGW_WEEKLY_STADIUM_UID_2026';

let currentMapUid = DEFAULT_MAP_UID;
let reqHandle = 0x80000001;

function buildXmlRpcCall(methodName, paramsXml = '') {
  return `<?xml version="1.0" encoding="utf-8"?><methodCall><methodName>${methodName}</methodName><params>${paramsXml}</params></methodCall>`;
}

function sendXmlRpc(socket, xml) {
  const body = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length, 0);
  header.writeUInt32LE(reqHandle++, 4);
  if (reqHandle > 0xffffffff) reqHandle = 0x80000001;
  socket.write(Buffer.concat([header, body]));
}

async function notifyHgwWebhook(playerLogin, timeMs, mapUid) {
  try {
    const res = await fetch(HGW_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TMNF-Secret': TMNF_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        playerLogin,
        mapUid,
        timeMs,
      }),
    });
    const data = await res.json();
    console.log(
      `🏁 [TMNF Bridge] Chrono envoyé : login=${playerLogin} time=${timeMs}ms map=${mapUid} ->`,
      data.ok ? 'OK' : data.error
    );
  } catch (err) {
    console.error('⚠️ [TMNF Bridge] Erreur HTTP vers HGW:', err.message);
  }
}

function connectBridge() {
  console.log(`🔌 [TMNF Bridge] Connexion à TrackmaniaServer XML-RPC (${XMLRPC_HOST}:${XMLRPC_PORT})...`);
  const socket = net.createConnection({ host: XMLRPC_HOST, port: XMLRPC_PORT });

  let handshakeDone = false;
  let recvBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    recvBuffer = Buffer.concat([recvBuffer, chunk]);

    if (!handshakeDone) {
      if (recvBuffer.length < 4) return;
      const protoLen = recvBuffer.readUInt32LE(0);
      if (recvBuffer.length < 4 + protoLen) return;
      const protoName = recvBuffer.subarray(4, 4 + protoLen).toString('ascii');
      recvBuffer = recvBuffer.subarray(4 + protoLen);
      handshakeDone = true;
      console.log(`✅ [TMNF Bridge] Handshake réussi (${protoName}). Authentification SuperAdmin...`);

      // 1. Authenticate
      sendXmlRpc(
        socket,
        buildXmlRpcCall(
          'Authenticate',
          `<param><value><string>${SUPERADMIN_USER}</string></value></param><param><value><string>${SUPERADMIN_PASS}</string></value></param>`
        )
      );
      // 2. EnableCallbacks(true)
      sendXmlRpc(
        socket,
        buildXmlRpcCall('EnableCallbacks', `<param><value><boolean>1</boolean></value></param>`)
      );
      // 3. GetCurrentChallengeInfo
      sendXmlRpc(socket, buildXmlRpcCall('GetCurrentChallengeInfo'));
    }

    // Lecture des trames GBXRemote 2 (4 octets taille + 4 octets handle + payload XML)
    while (recvBuffer.length >= 8) {
      const size = recvBuffer.readUInt32LE(0);
      const handle = recvBuffer.readUInt32LE(4);
      if (recvBuffer.length < 8 + size) break;

      const xmlPayload = recvBuffer.subarray(8, 8 + size).toString('utf8');
      recvBuffer = recvBuffer.subarray(8 + size);

      handleIncomingXml(xmlPayload, handle);
    }
  });

  socket.on('error', (err) => {
    console.error('⚠️ [TMNF Bridge] Erreur socket:', err.message);
  });

  socket.on('close', () => {
    console.log('🔄 [TMNF Bridge] Connexion fermée, reconnexion dans 5 secondes...');
    setTimeout(connectBridge, 5000);
  });
}

function handleIncomingXml(xml, _handle) {
  // Détection d'un changement de map ou de la réponse à GetCurrentChallengeInfo
  const uidMatch = xml.match(/<name>UId<\/name>\s*<value><string>([^<]+)<\/string><\/value>/i);
  if (uidMatch && uidMatch[1]) {
    currentMapUid = uidMatch[1].trim();
    console.log(`🗺️ [TMNF Bridge] Map active détectée : ${currentMapUid}`);
  }

  // Détection du callback TrackMania.PlayerFinish(PlayerUid, Login, TimeOrScore)
  if (xml.includes('<methodName>TrackMania.PlayerFinish</methodName>')) {
    const paramsMatches = [...xml.matchAll(/<param>\s*<value>\s*<(?:int|i4|string)>([^<]+)<\/(?:int|i4|string)>\s*<\/value>\s*<\/param>/gi)];
    if (paramsMatches.length >= 3) {
      const playerLogin = paramsMatches[1][1].trim();
      const timeOrScore = Number.parseInt(paramsMatches[2][1], 10);
      // TimeOrScore > 0 signifie que le joueur a terminé la course (0 = abandon/respawn)
      if (playerLogin && Number.isFinite(timeOrScore) && timeOrScore > 0) {
        notifyHgwWebhook(playerLogin, timeOrScore, currentMapUid);
      }
    }
  }
}

connectBridge();
