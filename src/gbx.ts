import crypto from 'node:crypto';

export interface ParsedGbxReplay {
  valid: boolean;
  error?: string;
  sha256: string;
  gbxVersion?: number;
  headerType?: string;
  mapUid?: string;
  environment?: string;
  bestTimeMs?: number;
  formattedTime?: string;
  respawns?: number;
  stuntScore?: number;
  playerLogin?: string;
  playerNickname?: string;
  xmlRaw?: string;
}

/**
 * Formate un temps en millisecondes au format Trackmania `M:SS.mmm` (ex: `0:23.780`).
 */
export function formatTmTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMs = Math.round(ms);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Parse et vérifie l'intégrité d'un fichier `.Replay.gbx` Trackmania Nations Forever :
 * 1. Vérifie les magic bytes `GBX` (`0x47 0x42 0x58`) et la version binaire (>= 6).
 * 2. Calcule l'empreinte SHA-256 du binaire complet (anti-partage de replay entre joueurs).
 * 3. Extrait le bloc `<header ...>...</header>` XML embarqué et valide la présence d'un payload binaire après le header (anti-fichier texte renommé en .gbx).
 * 4. Extrait l'UID de la map, le meilleur temps (`best`), le nombre de respawns et le login TMNF du joueur.
 */
export function parseReplayGbx(buffer: Buffer): ParsedGbxReplay {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  if (!buffer || buffer.length < 64) {
    return {
      valid: false,
      error: 'Fichier .Replay.gbx invalide ou tronqué (taille < 64 octets).',
      sha256,
    };
  }

  // Vérification des magic bytes "GBX"
  const magic = buffer.subarray(0, 3).toString('ascii');
  if (magic !== 'GBX') {
    return {
      valid: false,
      error: 'Entête binaire GBX manquant : ce fichier n’est pas un binaire Trackmania (.gbx) authentique.',
      sha256,
    };
  }

  const gbxVersion = buffer.readUInt16LE(3);
  if (gbxVersion < 5 || gbxVersion > 9) {
    return {
      valid: false,
      error: `Version binaire GBX non supportée (v${gbxVersion}). Utilisez un replay Trackmania Nations Forever.`,
      sha256,
    };
  }

  // Recherche du bloc XML <header ...>...</header>
  const contentLatin1 = buffer.toString('latin1');
  const startIdx = contentLatin1.indexOf('<header');
  const endTag = '</header>';
  const endIdx = contentLatin1.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return {
      valid: false,
      error: 'Bloc XML <header>...</header> introuvable dans le fichier .Replay.gbx.',
      sha256,
    };
  }

  const afterHeaderBytes = buffer.length - (endIdx + endTag.length);
  if (afterHeaderBytes < 16) {
    return {
      valid: false,
      error: 'Payload binaire de course manquant après le header XML (fichier .gbx corrompu ou falsifié).',
      sha256,
    };
  }

  const xmlRaw = buffer.subarray(startIdx, endIdx + endTag.length).toString('utf8');

  const headerTypeMatch = xmlRaw.match(/<header[^>]*\btype="([^"]+)"/i);
  const headerType = headerTypeMatch ? headerTypeMatch[1].toLowerCase() : 'replay';
  if (headerType !== 'replay') {
    return {
      valid: false,
      error: `Type de fichier GBX invalide ("${headerType}"). Vous devez déposer un fichier .Replay.gbx (pas une map .Challenge.gbx).`,
      sha256,
    };
  }

  const challengeUidMatch = xmlRaw.match(/<challenge[^>]*\buid="([^"]+)"/i);
  const descEnvMatch = xmlRaw.match(/<desc[^>]*\benvir="([^"]+)"/i);
  const timesBestMatch = xmlRaw.match(/<times[^>]*\bbest="(\d+)"/i);
  const timesRespawnsMatch = xmlRaw.match(/<times[^>]*\brespawns="(\d+)"/i);
  const timesStuntMatch = xmlRaw.match(/<times[^>]*\bstuntscore="(\d+)"/i);
  const playerLoginMatch = xmlRaw.match(/<player[^>]*\blogin="([^"]+)"/i);
  const playerNickMatch = xmlRaw.match(/<player[^>]*\bnickname="([^"]*)"/i);

  if (!challengeUidMatch || !challengeUidMatch[1]) {
    return {
      valid: false,
      error: 'UID de la map (<challenge uid="..."/>) introuvable dans le replay.',
      sha256,
    };
  }

  if (!timesBestMatch || !timesBestMatch[1]) {
    return {
      valid: false,
      error: 'Chrono (<times best="..."/>) introuvable dans le replay.',
      sha256,
    };
  }

  const bestTimeMs = Number.parseInt(timesBestMatch[1], 10);
  if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 1000 || bestTimeMs > 3600000) {
    return {
      valid: false,
      error: `Chrono invalide ou hors limites (${bestTimeMs} ms).`,
      sha256,
    };
  }

  const playerLogin = playerLoginMatch?.[1]?.trim() || 'unknown_driver';
  const playerNickname = playerNickMatch?.[1]?.trim() || playerLogin;

  return {
    valid: true,
    sha256,
    gbxVersion,
    headerType,
    mapUid: challengeUidMatch[1].trim(),
    environment: descEnvMatch?.[1] || 'Stadium',
    bestTimeMs,
    formattedTime: formatTmTime(bestTimeMs),
    respawns: timesRespawnsMatch ? Number.parseInt(timesRespawnsMatch[1], 10) : 0,
    stuntScore: timesStuntMatch ? Number.parseInt(timesStuntMatch[1], 10) : 0,
    playerLogin,
    playerNickname,
    xmlRaw,
  };
}

/**
 * Génère un buffer binaire `.Replay.gbx` valide (pour les tests automatisés et la démo).
 */
export function buildSampleReplayGbx(opts: {
  mapUid: string;
  bestTimeMs: number;
  playerLogin: string;
  playerNickname?: string;
  respawns?: number;
  nonce?: string;
}): Buffer {
  const xml = `<header type="replay" version="2" exever="2.11.26"><ident uid="${opts.mapUid}" name="HGW_Track" author="Nadeo"/><desc envir="Stadium" mood="Day" maptype="Race" mapstyle=""/><challenge uid="${opts.mapUid}"/><times best="${opts.bestTimeMs}" respawns="${opts.respawns ?? 0}" stuntscore="0" validable="1"/><player login="${opts.playerLogin}" nickname="${opts.playerNickname ?? opts.playerLogin}"/></header>`;

  const prefix = Buffer.alloc(17);
  prefix.write('GBX', 0, 'ascii');
  prefix.writeUInt16LE(6, 3); // version 6
  prefix.write('BUCR', 5, 'ascii');
  prefix.writeUInt32LE(0x03093000, 9); // CGameCtnReplayRecord class ID
  prefix.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 13);

  const xmlBuf = Buffer.from(xml, 'utf8');
  const bodySeed = `${opts.mapUid}:${opts.bestTimeMs}:${opts.playerLogin}:${opts.nonce ?? 'hgw'}`;
  const ghostPayload = crypto.createHash('sha512').update(bodySeed).digest();

  return Buffer.concat([prefix, xmlBuf, ghostPayload]);
}

export interface ParsedGbxChallenge {
  valid: boolean;
  error?: string;
  headerType?: string;
  mapUid?: string;
  name?: string;
  author?: string;
  environment?: string;
  authorMs?: number;
  goldMs?: number;
  silverMs?: number;
  bronzeMs?: number;
}

/**
 * Nettoie les codes couleur Trackmania ($fff, $o, $s, $w, $i, $t, $n, $g, $z, $l[...], $$).
 */
export function stripTmFormatting(raw: string): string {
  return String(raw || '')
    .replace(/\$\$/g, '\u0000')
    .replace(/\$[lh]\[[^\]]*\]/gi, '')
    .replace(/\$[0-9a-f]{3}/gi, '')
    .replace(/\$[a-z]/gi, '')
    .replace(/\u0000/g, '$')
    .trim();
}

/**
 * Parse un fichier `.Challenge.gbx` / `.Map.gbx` (ou un `.Replay.gbx`) pour pré-remplir
 * automatiquement une piste dans le dashboard admin (UID, nom, environnement, temps médailles).
 */
export function parseChallengeGbx(buffer: Buffer): ParsedGbxChallenge {
  if (!buffer || buffer.length < 64) {
    return { valid: false, error: 'Fichier GBX invalide ou tronqué.' };
  }
  if (buffer.subarray(0, 3).toString('ascii') !== 'GBX') {
    return { valid: false, error: 'Entête binaire GBX manquant : ce fichier n’est pas un fichier Trackmania (.gbx).' };
  }

  const contentLatin1 = buffer.toString('latin1');
  const startIdx = contentLatin1.indexOf('<header');
  const endTag = '</header>';
  const endIdx = contentLatin1.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { valid: false, error: 'Bloc XML <header> introuvable dans ce fichier .gbx.' };
  }

  const xmlRaw = buffer.subarray(startIdx, endIdx + endTag.length).toString('utf8');
  const headerTypeMatch = xmlRaw.match(/<header[^>]*\btype="([^"]+)"/i);
  const headerType = (headerTypeMatch?.[1] || '').toLowerCase();

  const identUid = xmlRaw.match(/<ident[^>]*\buid="([^"]+)"/i)?.[1]?.trim();
  const identName = xmlRaw.match(/<ident[^>]*\bname="([^"]*)"/i)?.[1] || '';
  const identAuthor = xmlRaw.match(/<ident[^>]*\bauthor="([^"]*)"/i)?.[1] || '';
  const challengeUid = xmlRaw.match(/<challenge[^>]*\buid="([^"]+)"/i)?.[1]?.trim();
  const envir = xmlRaw.match(/<desc[^>]*\benvir="([^"]+)"/i)?.[1]?.trim() || 'Stadium';

  const mapUid = headerType === 'replay' ? challengeUid || identUid : identUid || challengeUid;
  if (!mapUid) {
    return { valid: false, error: 'UID de la piste introuvable dans le header XML.' };
  }

  const numAttr = (attr: string): number | undefined => {
    const m = xmlRaw.match(new RegExp(`<times[^>]*\\b${attr}="(\\d+)"`, 'i'));
    if (!m) return undefined;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const authorMs = numAttr('authortime') ?? numAttr('best');
  const goldMs = numAttr('gold');
  const silverMs = numAttr('silver');
  const bronzeMs = numAttr('bronze');

  return {
    valid: true,
    headerType: headerType || 'challenge',
    mapUid,
    name: stripTmFormatting(identName) || mapUid,
    author: stripTmFormatting(identAuthor) || undefined,
    environment: envir,
    authorMs,
    goldMs,
    silverMs,
    bronzeMs,
  };
}

/**
 * Génère un buffer binaire `.Challenge.gbx` valide (pour les tests automatisés).
 */
export function buildSampleChallengeGbx(opts: {
  mapUid: string;
  name: string;
  author?: string;
  environment?: string;
  authorMs: number;
  goldMs: number;
  silverMs: number;
  bronzeMs: number;
}): Buffer {
  const xml = `<header type="challenge" version="2" exever="2.11.26"><ident uid="${opts.mapUid}" name="${opts.name}" author="${opts.author || 'Nadeo'}"/><desc envir="${opts.environment || 'Stadium'}" mood="Day" type="Race"/><times bronze="${opts.bronzeMs}" silver="${opts.silverMs}" gold="${opts.goldMs}" authortime="${opts.authorMs}"/></header>`;
  const prefix = Buffer.alloc(17);
  prefix.write('GBX', 0, 'ascii');
  prefix.writeUInt16LE(6, 3);
  prefix.write('BUCR', 5, 'ascii');
  prefix.writeUInt32LE(0x03043000, 9);
  prefix.writeUInt32LE(Buffer.byteLength(xml, 'utf8'), 13);
  const xmlBuf = Buffer.from(xml, 'utf8');
  const body = crypto.createHash('sha256').update(opts.mapUid).digest();
  return Buffer.concat([prefix, xmlBuf, body]);
}

