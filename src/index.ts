import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import multer from 'multer';
import cron from 'node-cron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HgwDiscordBot } from './bot.js';
import { createGame, createQuest, deleteGame, deleteQuest, listCatalog, updateGame, updateQuest } from './catalog.js';
import { initDb } from './db.js';
import {
  drawDailyQuestsForUser,
  generateBalancedTeams,
  getEventSettings,
  getGlobalLeaderboard,
  getMapLeaderboard,
  getParisDayAndWeekKey,
  grantManualPoints,
  MAX_WEEKLY_QUESTS_PER_GAME,
  recalculateUserRegularityBonuses,
  recalculateWeeklyTmnfLeaderboard,
  recordTmnfLiveServerFinish,
  recordTournamentPlacements,
  rerollDailyAssignment,
  reviewDailyAssignment,
  runNightlyDailyReset,
  saveUserSelectedGames,
  submitDailyProof,
  submitTmnfReplay,
  TOMBOLA_POINTS_THRESHOLD,
  updateEventSettings,
  updateFallGuysScoresAndRankings,
} from './engine.js';
import { buildSampleReplayGbx, formatTmTime } from './gbx.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hgw-dev-secret-change-in-production-2026';
const COOKIE_NAME = 'hgw_session';

// Mode démo (connexion de test, joueurs fictifs, replays d'exemple).
// Fermé par défaut : en production il faut ALLOW_DEV_LOGIN=true explicitement.
// En local (NODE_ENV ≠ production) il reste actif tant que Discord OAuth n'est pas configuré.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_MODE =
  process.env.ALLOW_DEV_LOGIN === 'true' || (!IS_PRODUCTION && !process.env.DISCORD_CLIENT_ID?.trim());
if (IS_PRODUCTION && SESSION_SECRET.startsWith('hgw-dev-secret')) {
  console.warn('⚠️  SESSION_SECRET par défaut utilisé en production : définissez-en un dans .env.');
}

function requireDevMode(_req: Request, res: Response, next: NextFunction): void {
  if (!DEV_MODE) {
    res.status(403).json({ error: 'Fonction disponible uniquement en mode démo.' });
    return;
  }
  next();
}

// Hub Temps Réel SSE (Server-Sent Events)
const sseClients = new Set<Response>();
function broadcastRealtimeEvent(type: string, message?: string, payload?: any): void {
  const data = JSON.stringify({ type, message, payload, ts: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

const { db, proofsDir, replaysDir, logosDir } = initDb();
const STEAMGRIDDB_API_KEY = process.env.STEAMGRIDDB_API_KEY?.trim() || '';
const bot = new HgwDiscordBot(db, proofsDir, (msg) => {
  broadcastRealtimeEvent('points_updated', msg);
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Fichiers statiques et preuves
const publicDir = path.resolve(__dirname, '../public');
app.use('/uploads/proofs', express.static(proofsDir));
app.use('/uploads/logos', express.static(logosDir, { maxAge: '7d', immutable: true }));
app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    },
  })
);

// Signatures HMAC de session (sans dépendance externe lourde)
function signSessionToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token?: string): string | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.uid === 'string' ? data.uid : null;
  } catch {
    return null;
  }
}

interface AuthedRequest extends Request {
  user?: any;
}

function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const uid = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  if (uid) {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(uid);
    if (user) req.user = user;
  }
  next();
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentification requise. Connectez-vous avec Discord.' });
    return;
  }
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.is_admin !== 1) {
    res.status(403).json({ error: 'Accès réservé aux administrateurs HGW.' });
    return;
  }
  next();
}

app.use(attachUser);

// Rate-limiter léger en mémoire pour protéger les routes d'upload contre le spam
const rateBuckets = new Map<string, number[]>();
function createRateLimiter(maxRequests: number, windowMs: number) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const key = `${req.user?.id || req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const recent = (rateBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
    if (recent.length >= maxRequests) {
      res.status(429).json({ error: 'Trop de requêtes rapprochées. Patiente quelques secondes avant de réessayer.' });
      return;
    }
    recent.push(now);
    rateBuckets.set(key, recent);
    next();
  };
}

// Vérifie les magic bytes d'une preuve uploadée (PNG, JPEG, GIF, WEBP, MP4, WEBM)
function isValidMediaMagicBytes(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (bytesRead < 4) return false;
    // PNG: 89 50 4E 47
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
    // JPEG: FF D8 FF
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
    // GIF: 47 49 46 38
    if (head.subarray(0, 4).toString('ascii') === 'GIF8') return true;
    // WEBP: RIFF....WEBP
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return true;
    // MP4 / MOV: ....ftyp
    if (head.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    // WEBM / MKV: 1A 45 DF A3
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
    return false;
  } catch {
    return false;
  }
}

// Multer pour upload de preuves (images <= 10 Mo, vidéos courtes <= 20 Mo)
const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, proofsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(ext)
        ? ext
        : '.bin';
      cb(null, `proof_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Multer en mémoire pour les replays Trackmania (.Replay.gbx <= 5 Mo)
const gbxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ============================================================================
// AUTHENTIFICATION DISCORD OAUTH2 + MODE DEMO/DEV
// ============================================================================

app.get('/api/auth/discord', (_req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const redirectUri =
    process.env.DISCORD_REDIRECT_URI?.trim() || `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/auth/discord/callback`;

  if (!clientId) {
    res.redirect('/?auth=dev_required');
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/api/auth/discord/callback', async (req, res) => {
  const code = String(req.query.code || '');
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  const redirectUri =
    process.env.DISCORD_REDIRECT_URI?.trim() || `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/auth/discord/callback`;

  if (!code || !clientId || !clientSecret) {
    res.redirect('/?error=oauth_misconfigured');
    return;
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      throw new Error(`Discord token error: ${tokenRes.status}`);
    }
    const tokenData = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) {
      throw new Error(`Discord user error: ${userRes.status}`);
    }
    const discordUser = (await userRes.json()) as {
      id: string;
      username: string;
      global_name?: string;
      avatar?: string;
    };

    const adminIds = (process.env.ADMIN_DISCORD_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const totalUsers = (db.prepare(`SELECT COUNT(*) AS cnt FROM users`).get() as { cnt: number }).cnt;
    const isAdmin = adminIds.includes(discordUser.id) || totalUsers === 0 ? 1 : 0;

    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : null;

    db.prepare(
      `INSERT INTO users (id, username, display_name, avatar, is_admin)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         avatar = excluded.avatar,
         is_admin = CASE WHEN users.is_admin = 1 THEN 1 ELSE excluded.is_admin END`
    ).run(
      discordUser.id,
      discordUser.username,
      discordUser.global_name || discordUser.username,
      avatarUrl,
      isAdmin
    );

    const token = signSessionToken(discordUser.id);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 14 * 24 * 3600 * 1000,
    });
    res.redirect('/');
  } catch (err: any) {
    console.error('❌ [OAuth2] Erreur callback Discord:', err?.message || err);
    res.redirect('/?error=oauth_failed');
  }
});

// Connexion rapide en mode démo (voir DEV_MODE)
app.post('/api/auth/dev-login', (req, res) => {
  if (!DEV_MODE) {
    res.status(403).json({ error: 'Le mode Dev Login est désactivé en production.' });
    return;
  }

  const rawName = String(req.body.username || 'Hextaz').trim().slice(0, 32) || 'Hextaz';
  const asAdmin = req.body.isAdmin === true;
  const userId = String(req.body.userId || `user_${rawName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`);

  db.prepare(
    `INSERT INTO users (id, username, display_name, is_admin)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       display_name = excluded.display_name,
       is_admin = excluded.is_admin`
  ).run(userId, rawName.toLowerCase(), rawName, asAdmin ? 1 : 0);

  const token = signSessionToken(userId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 14 * 24 * 3600 * 1000,
  });

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  res.json({ ok: true, user });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ============================================================================
// ÉTAT GLOBAL & PROFIL JOUEUR
// ============================================================================

app.get('/api/state', (req: AuthedRequest, res) => {
  const { dayKey, weekKey } = getParisDayAndWeekKey();
  const games = db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM quests q WHERE q.game_id = g.id AND q.active = 1) AS active_quest_count
       FROM games g ORDER BY g.sort_order ASC`
    )
    .all();
  const leaderboard = getGlobalLeaderboard(db);
  const weeklyTmnf = recalculateWeeklyTmnfLeaderboard(db);

  // Records du serveur (WR Discord) par map Trackmania
  const wrRows = db
    .prepare(
      `SELECT ts.map_id, ts.time_ms, u.display_name
       FROM tmnf_submissions ts
       JOIN users u ON u.id = ts.user_id
       WHERE ts.time_ms = (
         SELECT MIN(t2.time_ms) FROM tmnf_submissions t2 WHERE t2.map_id = ts.map_id
       )
       GROUP BY ts.map_id`
    )
    .all() as { map_id: string; time_ms: number; display_name: string }[];
  const wrByMap = new Map(wrRows.map((r) => [r.map_id, r]));

  const tmnfMaps = db.prepare(`SELECT * FROM tmnf_maps ORDER BY sort_order ASC`).all() as any[];
  const formattedMaps = tmnfMaps.map((m) => {
    const wr = wrByMap.get(m.id);
    return {
      ...m,
      author_formatted: formatTmTime(m.author_ms),
      gold_formatted: formatTmTime(m.gold_ms),
      silver_formatted: formatTmTime(m.silver_ms),
      bronze_formatted: formatTmTime(m.bronze_ms),
      wr_time_ms: wr ? wr.time_ms : null,
      wr_formatted: wr ? formatTmTime(wr.time_ms) : null,
      wr_holder: wr ? wr.display_name : null,
    };
  });

  // Fil d'activité global en direct (25 derniers mouvements de points)
  const recentFeed = db
    .prepare(
      `SELECT pl.*, u.display_name, u.avatar
       FROM points_ledger pl
       JOIN users u ON u.id = pl.user_id
       ORDER BY pl.updated_at DESC, pl.id DESC
       LIMIT 25`
    )
    .all();

  const tournaments = db.prepare(`SELECT * FROM tournaments ORDER BY sort_order ASC`).all() as any[];
  const allRegs = db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       ORDER BY tr.pool ASC, tr.registered_at ASC`
    )
    .all() as any[];

  const tournamentsWithRegs = tournaments.map((t) => ({
    ...t,
    points_scale: JSON.parse(t.points_scale_json),
    registrations: allRegs
      .filter((r) => r.tournament_id === t.id)
      .map((r) => ({
        ...r,
        fg_shows: JSON.parse(r.fg_shows_json || '[0,0,0,0,0]'),
      })),
  }));

  let mySelectedGames: string[] = [];
  let myDailyQuests: any[] = [];
  let myWeeklyGameCounts: Record<string, number> = {};
  let myRegularity: any = {
    activeDaysCount: 0,
    totalBonusPoints: 0,
    tiers: [
      { days: 4, points: 20, unlocked: false },
      { days: 8, points: 40, unlocked: false },
      { days: 12, points: 60, unlocked: false },
    ],
  };
  let myTmnfSubmissions: any[] = [];
  let myLedger: any[] = [];
  let canRerollToday = false;

  if (req.user) {
    mySelectedGames = (
      db.prepare(`SELECT game_id FROM user_games WHERE user_id = ?`).all(req.user.id) as { game_id: string }[]
    ).map((r) => r.game_id);

    if (mySelectedGames.length >= 4) {
      myDailyQuests = drawDailyQuestsForUser(db, req.user.id);
    }

    myRegularity = recalculateUserRegularityBonuses(db, req.user.id);

    const weeklyRows = db
      .prepare(
        `SELECT q.game_id, COUNT(*) AS cnt
         FROM daily_assignments da
         JOIN quests q ON q.id = da.quest_id
         WHERE da.user_id = ? AND da.week_key = ? AND da.status IN ('validated', 'submitted')
         GROUP BY q.game_id`
      )
      .all(req.user.id, weekKey) as { game_id: string; cnt: number }[];
    for (const r of weeklyRows) {
      myWeeklyGameCounts[r.game_id] = r.cnt;
    }

    myTmnfSubmissions = db
      .prepare(
        `SELECT map_id, MIN(time_ms) AS best_time_ms, MAX(points_awarded) AS best_points
         FROM tmnf_submissions
         WHERE user_id = ?
         GROUP BY map_id`
      )
      .all(req.user.id)
      .map((r: any) => ({
        ...r,
        best_time_formatted: formatTmTime(r.best_time_ms),
      }));

    myLedger = db
      .prepare(`SELECT * FROM points_ledger WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 30`)
      .all(req.user.id);

    canRerollToday = !(req.user.reroll_day_key === dayKey && req.user.rerolls_used >= 1);
  }

  const eventSettings = getEventSettings(db);

  let pendingProofs: any[] = [];
  let allUsers: any[] = [];
  let stats: any = null;
  if (req.user?.is_admin === 1) {
    pendingProofs = db
      .prepare(
        `SELECT da.*, q.title, q.description, q.difficulty, q.points, g.name AS game_name, g.emoji AS game_emoji, u.display_name, u.username
         FROM daily_assignments da
         JOIN quests q ON q.id = da.quest_id
         JOIN games g ON g.id = q.game_id
         JOIN users u ON u.id = da.user_id
         WHERE da.status = 'submitted'
         ORDER BY da.submitted_at ASC`
      )
      .all();

    allUsers = db.prepare(`SELECT id, username, display_name, tmnf_login, is_admin FROM users ORDER BY display_name ASC`).all();

    const totalReplays = (db.prepare(`SELECT COUNT(*) AS cnt FROM tmnf_submissions`).get() as { cnt: number }).cnt;
    const totalValidatedQuests = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM daily_assignments WHERE status = 'validated'`).get() as { cnt: number }
    ).cnt;
    const totalPoints = (
      db.prepare(`SELECT COALESCE(SUM(points), 0) AS tot FROM points_ledger`).get() as { tot: number }
    ).tot;

    stats = {
      totalUsers: allUsers.length,
      pendingProofsCount: pendingProofs.length,
      totalReplays,
      totalValidatedQuests,
      totalPoints,
      tombolaQualifiedCount: leaderboard.filter((p) => p.tombola_eligible).length,
    };
  }

  res.json({
    serverTime: new Date().toISOString(),
    dayKey,
    weekKey,
    eventSettings,
    maxWeeklyQuestsPerGame: MAX_WEEKLY_QUESTS_PER_GAME,
    oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID?.trim()),
    allowDevLogin: DEV_MODE,
    devMode: DEV_MODE,
    botStatus: bot.getStatus(),
    tmnfServer: {
      login: eventSettings.tmnf_server_login,
      playitAddress: eventSettings.tmnf_playit_address,
      joinUrl: eventSettings.tmnf_join_url,
    },
    tombolaThreshold: TOMBOLA_POINTS_THRESHOLD,
    user: req.user || null,
    mySelectedGames,
    myDailyQuests,
    myWeeklyGameCounts,
    myRegularity,
    canRerollToday,
    myTmnfSubmissions,
    myLedger,
    recentFeed,
    games,
    tmnfMaps: formattedMaps,
    weeklyTmnfLeaderboard: weeklyTmnf,
    tournaments: tournamentsWithRegs,
    leaderboard,
    admin: req.user?.is_admin === 1 ? { pendingProofs, allUsers, stats } : null,
  });
});

// Flux Temps Réel Server-Sent Events (SSE)
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Détail complet du journal de points (points_ledger) d'un joueur au clic sur le classement
app.get('/api/player/:id/ledger', (req, res) => {
  const userId = String(req.params.id);
  const player = db
    .prepare(`SELECT id, username, display_name, avatar, tmnf_login, created_at FROM users WHERE id = ?`)
    .get(userId) as any;

  if (!player) {
    res.status(404).json({ error: 'Joueur introuvable.' });
    return;
  }

  const entries = db
    .prepare(`SELECT * FROM points_ledger WHERE user_id = ? ORDER BY updated_at DESC, id DESC`)
    .all(userId);

  const selectedGames = db
    .prepare(
      `SELECT g.id, g.name, g.short_name, g.emoji
       FROM user_games ug
       JOIN games g ON g.id = ug.game_id
       WHERE ug.user_id = ?
       ORDER BY g.sort_order ASC`
    )
    .all(userId);

  res.json({
    ok: true,
    player,
    selectedGames,
    entries,
  });
});

// Liaison directe du Login Trackmania (pour remontée auto des chronos depuis le serveur dédié)
app.post('/api/profile/tmnf-login', requireAuth, (req: AuthedRequest, res) => {
  const tmnfLogin = String(req.body.tmnfLogin || '').trim().slice(0, 40);
  db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(tmnfLogin || null, req.user.id);
  broadcastRealtimeEvent('profile_updated');
  res.json({ ok: true, tmnfLogin: tmnfLogin || null });
});

// Mise à jour du profil (jeux cochés + login TMNF optionnel)
app.post('/api/profile/games', requireAuth, (req: AuthedRequest, res) => {
  try {
    const gameIds = Array.isArray(req.body.gameIds) ? req.body.gameIds.map(String) : [];
    const tmnfLogin = typeof req.body.tmnfLogin === 'string' ? req.body.tmnfLogin.trim() : undefined;

    if (tmnfLogin !== undefined) {
      db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(tmnfLogin || null, req.user.id);
    }

    const result = saveUserSelectedGames(db, req.user.id, gameIds);
    const quests = drawDailyQuestsForUser(db, req.user.id);
    res.json({ ok: true, ...result, quests });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Impossible de sauvegarder vos jeux.' });
  }
});

// Reroll d'un défi quotidien (1 max par jour)
app.post('/api/quests/:id/reroll', requireAuth, (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const quests = rerollDailyAssignment(db, req.user.id, assignmentId);
    res.json({ ok: true, quests });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Reroll impossible.' });
  }
});

// Soumission d'une preuve (upload fichier ou lien) avec Rate-Limit & Validation Magic Bytes
app.post(
  '/api/quests/:id/submit',
  requireAuth,
  createRateLimiter(20, 60_000),
  proofUpload.single('proofFile'),
  async (req: AuthedRequest, res) => {
    try {
      const assignmentId = Number.parseInt(String(req.params.id), 10);
      const proofUrl = typeof req.body.proofUrl === 'string' ? req.body.proofUrl.trim() : '';
      const proofNote = typeof req.body.proofNote === 'string' ? req.body.proofNote.trim() : '';
      const proofFile = req.file?.filename;

      if (proofFile && req.file?.path) {
        if (!isValidMediaMagicBytes(req.file.path)) {
          try {
            fs.unlinkSync(req.file.path);
          } catch {
            // ignore unlink error
          }
          res.status(400).json({
            error: 'Format de fichier non reconnu : veuillez envoyer une vraie image (PNG, JPG, WEBP, GIF) ou vidéo (MP4, WEBM).',
          });
          return;
        }
      }

      const updated = submitDailyProof(db, {
        userId: req.user.id,
        assignmentId,
        proofUrl: proofUrl || undefined,
        proofFile,
        proofNote: proofNote || undefined,
      });

      await bot.notifyProofSubmitted(updated);
      broadcastRealtimeEvent('proof_submitted', `🕵️ ${req.user.display_name} a soumis une preuve sur ${updated.game_name}`);
      res.json({ ok: true, assignment: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Échec de l’envoi de la preuve.' });
    }
  }
);

// ============================================================================
// TRACKMANIA (.Replay.gbx) UPLOAD SIMPLE + BATCH + CLASSEMENT PISTE + GHOST WR
// ============================================================================

app.post(
  '/api/tmnf/submit-replay',
  requireAuth,
  createRateLimiter(25, 60_000),
  gbxUpload.single('replay'),
  (req: AuthedRequest, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        res.status(400).json({ error: 'Veuillez sélectionner un fichier .Replay.gbx.' });
        return;
      }

      const explicitMapId = typeof req.body.mapId === 'string' ? req.body.mapId : undefined;
      const safeReplayName = `${Date.now()}_${req.user.id}_${crypto.randomBytes(3).toString('hex')}.Replay.gbx`;

      const result = submitTmnfReplay(db, {
        userId: req.user.id,
        buffer: req.file.buffer,
        fileName: safeReplayName,
        explicitMapId,
      });

      fs.writeFileSync(path.join(replaysDir, safeReplayName), req.file.buffer);

      broadcastRealtimeEvent(
        'tmnf_replay',
        `🏎️ ${req.user.display_name} a signé ${result.parsed.formattedTime} sur ${result.map.code}${result.deltaPoints > 0 ? ` (+${result.deltaPoints} pts)` : ''}`
      );

      res.json({
        ok: true,
        mapName: result.map.name,
        mapCode: result.map.code,
        isWeekly: Boolean(result.map.is_weekly),
        formattedTime: result.parsed.formattedTime,
        medal: result.medal,
        previousPoints: result.previousPoints,
        newPoints: result.newPoints,
        deltaPoints: result.deltaPoints,
        isPersonalBest: result.isPersonalBest,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Erreur lors de la lecture du fichier .Replay.gbx.' });
    }
  }
);

// Upload par lot (Batch Drag & Drop jusqu'à 12 fichiers .Replay.gbx d'un seul coup)
app.post(
  '/api/tmnf/submit-replays-batch',
  requireAuth,
  createRateLimiter(15, 60_000),
  gbxUpload.array('replays', 12),
  (req: AuthedRequest, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: 'Veuillez sélectionner au moins un fichier .Replay.gbx.' });
      return;
    }

    const results: any[] = [];
    let totalDeltaPoints = 0;
    let validCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const safeReplayName = `${Date.now()}_${req.user.id}_${crypto.randomBytes(3).toString('hex')}.Replay.gbx`;
        const out = submitTmnfReplay(db, {
          userId: req.user.id,
          buffer: file.buffer,
          fileName: safeReplayName,
        });
        fs.writeFileSync(path.join(replaysDir, safeReplayName), file.buffer);
        validCount++;
        totalDeltaPoints += out.deltaPoints;
        results.push({
          fileName: file.originalname,
          ok: true,
          mapCode: out.map.code,
          mapName: out.map.name,
          formattedTime: out.parsed.formattedTime,
          medal: out.medal,
          deltaPoints: out.deltaPoints,
          isPersonalBest: out.isPersonalBest,
        });
      } catch (err: any) {
        errorCount++;
        results.push({
          fileName: file.originalname,
          ok: false,
          error: err.message || 'Fichier .gbx invalide.',
        });
      }
    }

    if (validCount > 0) {
      broadcastRealtimeEvent(
        'tmnf_replay',
        `🏎️ ${req.user.display_name} a validé ${validCount} replay(s) Trackmania${totalDeltaPoints > 0 ? ` (+${totalDeltaPoints} pts)` : ''} !`
      );
    }

    res.json({
      ok: validCount > 0,
      validCount,
      errorCount,
      totalDeltaPoints,
      results,
    });
  }
);

// Classement complet d'une piste Trackmania (Chasse aux Médailles ou Map Hebdo)
app.get('/api/tmnf/map/:mapId/leaderboard', (req, res) => {
  try {
    const data = getMapLeaderboard(db, String(req.params.mapId));
    res.json({ ok: true, ...data });
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Piste introuvable.' });
  }
});

// Téléchargement du Ghost (.Replay.gbx) du WR Discord ou d'un joueur spécifique sur une piste
app.get('/api/tmnf/map/:mapId/ghost/:userId', (req, res) => {
  try {
    const mapId = String(req.params.mapId);
    const userId = String(req.params.userId);
    const data = getMapLeaderboard(db, mapId);
    const entry = data.entries.find((e) => e.user_id === userId) || data.entries[0];
    if (!entry) {
      res.status(404).json({ error: 'Aucun temps enregistré sur cette piste.' });
      return;
    }

    const downloadName = `Ghost_${data.map.code}_${entry.display_name.replace(/[^a-zA-Z0-9_-]/g, '')}_${entry.best_time_ms}ms.Replay.gbx`;

    if (entry.file_name) {
      const diskPath = path.join(replaysDir, path.basename(entry.file_name));
      if (fs.existsSync(diskPath)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        res.send(fs.readFileSync(diskPath));
        return;
      }
    }

    // Fallback synthétique avec le temps exact du joueur si le replay initial venait du seeder ou XML-RPC
    const buf = buildSampleReplayGbx({
      mapUid: data.map.uid,
      bestTimeMs: entry.best_time_ms,
      playerLogin: entry.tmnf_login || entry.display_name.toLowerCase(),
      playerNickname: entry.display_name,
      nonce: `ghost_${mapId}_${entry.user_id}`,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.send(buf);
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Ghost introuvable.' });
  }
});

/**
 * Webhook Temps Réel appelé automatiquement par le bridge XML-RPC du serveur dédié Trackmania (`infra/tmnf-xmlrpc-bridge.mjs`)
 * dès qu'un joueur franchit la ligne d'arrivée en jeu (`TrackMania.PlayerFinish`).
 */
app.post('/api/tmnf/webhook', (req: AuthedRequest, res) => {
  const configuredSecret = process.env.TMNF_WEBHOOK_SECRET?.trim();
  const headerSecret = String(req.headers['x-tmnf-secret'] || '');
  const isAdminSession = req.user?.is_admin === 1;

  // Fermé par défaut : sans TMNF_WEBHOOK_SECRET configuré, seule une session admin peut publier un chrono.
  const secretOk = Boolean(configuredSecret) && headerSecret === configuredSecret;
  if (!secretOk && !isAdminSession) {
    res.status(401).json({ error: 'Signature X-TMNF-Secret invalide ou absente.' });
    return;
  }

  try {
    const { playerLogin, playerNickname, mapUid, timeMs } = req.body;
    const out = recordTmnfLiveServerFinish(db, {
      playerLogin: String(playerLogin || ''),
      playerNickname: playerNickname ? String(playerNickname) : undefined,
      mapUid: String(mapUid || ''),
      timeMs: Number(timeMs),
    });

    if (out.matchedUser && out.map && (out.isPersonalBest || out.deltaPoints > 0)) {
      broadcastRealtimeEvent(
        'tmnf_live_finish',
        `🏁 [Serveur TMNF Live] ${out.matchedUser.display_name} vient de rouler ${out.formattedTime} sur ${out.map.code}${out.deltaPoints > 0 ? ` (+${out.deltaPoints} pts)` : ' (Nouveau PB !)'}`
      );
    }

    res.json({ ok: true, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erreur webhook TMNF.' });
  }
});

// Permet de télécharger un fichier .Replay.gbx d'exemple valide pour tester l'upload en 1 clic
app.get('/api/tmnf/sample-replay/:mapId', requireDevMode, requireAuth, (req: AuthedRequest, res) => {
  const map = db.prepare(`SELECT * FROM tmnf_maps WHERE id = ?`).get(String(req.params.mapId)) as any;
  if (!map) {
    res.status(404).json({ error: 'Map introuvable.' });
    return;
  }

  const sampleTime = map.author_ms - Math.floor(Math.random() * 350) - 40;
  const login = req.user.tmnf_login || req.user.username || 'hgw_pilot';
  const buf = buildSampleReplayGbx({
    mapUid: map.uid,
    bestTimeMs: sampleTime,
    playerLogin: login,
    playerNickname: req.user.display_name,
    nonce: `${Date.now()}_${req.user.id}`,
  });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${map.code}_${login}_${sampleTime}ms.Replay.gbx"`
  );
  res.send(buf);
});

// ============================================================================
// TOURNOIS LIVE (INSCRIPTION, CHAPEAUX 1/2/3, TIRAGE ÉQUIPES, FALL GUYS)
// ============================================================================

app.post('/api/tournaments/:id/toggle', requireAuth, (req: AuthedRequest, res) => {
  const tournamentId = String(req.params.id);
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  if (!tournament) {
    res.status(404).json({ error: 'Tournoi introuvable.' });
    return;
  }

  const existing = db
    .prepare(`SELECT * FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`)
    .get(tournamentId, req.user.id);

  if (existing) {
    db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`).run(
      tournamentId,
      req.user.id
    );
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, registered: false });
  } else {
    db.prepare(
      `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, ?, 2, 0)`
    ).run(tournamentId, req.user.id);
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, registered: true });
  }
});

// ============================================================================
// BACK-OFFICE ADMIN (VALIDATION PREUVES, CHAPEAUX, TIRAGE LIVE, BACKUP, TOMBOLA)
// ============================================================================

app.post('/api/admin/proofs/:id/review', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const action = req.body.action === 'reject' ? 'reject' : 'approve';
    const rejectReason = typeof req.body.rejectReason === 'string' ? req.body.rejectReason.trim() : undefined;
    if (action === 'reject' && !rejectReason) {
      res.status(400).json({ error: 'Un motif de refus est obligatoire : il est envoyé au joueur.' });
      return;
    }

    const updated = reviewDailyAssignment(db, {
      assignmentId,
      action,
      reviewerId: req.user.display_name,
      rejectReason,
    });
    broadcastRealtimeEvent(
      'points_updated',
      action === 'approve'
        ? `✅ ${updated.display_name} a validé "${updated.title}" (+${updated.points} pts)`
        : undefined
    );
    res.json({ ok: true, assignment: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/tournaments/:id/player', requireAdmin, (req: AuthedRequest, res) => {
  const tournamentId = String(req.params.id);
  const { userId, pool, checkedIn } = req.body;

  if (pool !== undefined) {
    const p = Number(pool);
    if ([1, 2, 3].includes(p)) {
      db.prepare(`UPDATE tournament_registrations SET pool = ? WHERE tournament_id = ? AND user_id = ?`).run(
        p,
        tournamentId,
        userId
      );
    }
  }
  if (checkedIn !== undefined) {
    db.prepare(`UPDATE tournament_registrations SET checked_in = ? WHERE tournament_id = ? AND user_id = ?`).run(
      checkedIn ? 1 : 0,
      tournamentId,
      userId
    );
  }
  broadcastRealtimeEvent('tournament_updated');
  res.json({ ok: true });
});

app.post('/api/admin/tournaments/:id/draw-teams', requireAdmin, async (req: AuthedRequest, res) => {
  try {
    const onlyCheckedIn = req.body.onlyCheckedIn !== undefined ? Boolean(req.body.onlyCheckedIn) : true;
    const result = generateBalancedTeams(db, String(req.params.id), onlyCheckedIn);
    if (req.body.announceDiscord) {
      await bot.announceTeams(result.tournament, result.teams);
    }
    broadcastRealtimeEvent('teams_drawn', `🎲 Les équipes de ${result.tournament.name} viennent d'être tirées au sort !`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/tournaments/:id/placements', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const placements = Array.isArray(req.body.placements) ? req.body.placements : [];
    recordTournamentPlacements(db, String(req.params.id), placements);
    broadcastRealtimeEvent('points_updated', '🏆 Classement de tournoi mis à jour !');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/fall-guys/scores', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const scores = Array.isArray(req.body.scores) ? req.body.scores : [];
    const updated = updateFallGuysScoresAndRankings(db, scores);
    broadcastRealtimeEvent('points_updated', '🫘 Scores Fall Guys mis à jour en direct !');
    res.json({ ok: true, standings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cron/trigger', requireAdmin, (_req: AuthedRequest, res) => {
  const result = runNightlyDailyReset(db);
  broadcastRealtimeEvent('daily_reset', '⏰ Nouveaux défis quotidiens générés !');
  res.json({ ok: true, ...result });
});

app.post('/api/admin/settings', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const updated = updateEventSettings(db, req.body || {});
    broadcastRealtimeEvent('settings_updated', '⚙️ Paramètres et dates de la HGW mis à jour !');
    res.json({ ok: true, eventSettings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/manual-points', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const { userId, points, category, label } = req.body;
    if (typeof label !== 'string' || label.trim().length < 3) {
      res.status(400).json({ error: 'Un motif est obligatoire (3 caractères minimum) : il apparaît dans l’historique du joueur.' });
      return;
    }
    grantManualPoints(db, {
      userId: String(userId || ''),
      points: Number(points),
      category: category === 'live' ? 'live' : 'async',
      label: label.trim().slice(0, 120),
    });
    broadcastRealtimeEvent('points_updated', `🎁 Points bonus attribués (${points > 0 ? `+${points}` : points} pts) !`);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/tombola/draw', requireAdmin, (_req: AuthedRequest, res) => {
  const lb = getGlobalLeaderboard(db);
  const qualified = lb.filter((p) => p.tombola_eligible);
  if (qualified.length === 0) {
    res.status(400).json({ error: 'Aucun joueur n’a encore atteint le seuil de 300 pts pour la Tombola.' });
    return;
  }
  const idx = crypto.randomInt(0, qualified.length);
  const winner = qualified[idx];
  broadcastRealtimeEvent(
    'tombola_winner',
    `🎟️ TIRAGE TOMBOLA HGW : Félicitations à ${winner.display_name} (${winner.total_points} pts) qui remporte la Grande Tombola !`,
    { winner, candidates: qualified, eligibleCount: qualified.length }
  );
  res.json({ ok: true, winner, candidates: qualified, eligibleCount: qualified.length });
});

// ============================================================================
// CATALOGUE JEUX & DÉFIS (CRUD admin + logos)
// ============================================================================

// Seuls les formats raster sont acceptés : un SVG servi depuis notre domaine pourrait embarquer du script.
function detectImageExt(buf: Buffer): '.png' | '.jpg' | '.webp' | '.gif' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return '.gif';
  return null;
}

function removeLocalLogo(logoUrl?: string | null): void {
  if (!logoUrl || !logoUrl.startsWith('/uploads/logos/')) return;
  const file = path.join(logosDir, path.basename(logoUrl));
  fs.rm(file, { force: true }, () => {});
}

function storeLogo(gameId: string, buf: Buffer): string {
  const ext = detectImageExt(buf);
  if (!ext) throw new Error('Format non pris en charge : PNG, JPEG, WEBP ou GIF uniquement (pas de SVG).');
  const name = `${gameId.replace(/[^a-z0-9_-]/gi, '')}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(logosDir, name), buf);
  return `/uploads/logos/${name}`;
}

function setGameLogo(gameId: string, buf: Buffer): any {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId) as any;
  if (!game) throw new Error('Jeu introuvable.');
  const url = storeLogo(gameId, buf);
  const updated = updateGame(db, gameId, { logo_url: url });
  removeLocalLogo(game.logo_url);
  return updated;
}

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

function catalogChanged(): void {
  broadcastRealtimeEvent('catalog_updated');
}

app.get('/api/admin/catalog', requireAdmin, (_req: AuthedRequest, res) => {
  res.json({ ...listCatalog(db), logoSearchEnabled: Boolean(STEAMGRIDDB_API_KEY) });
});

app.post('/api/admin/games', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const game = createGame(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/games/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id);
    const before = db.prepare(`SELECT logo_url FROM games WHERE id = ?`).get(id) as { logo_url: string | null } | undefined;
    const game = updateGame(db, id, req.body || {});
    if (before && before.logo_url !== game.logo_url) removeLocalLogo(before.logo_url);
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/games/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const result = deleteGame(db, String(req.params.id));
    removeLocalLogo(result.logo_url);
    catalogChanged();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/admin/games/:id/logo', requireAdmin, logoUpload.single('logo'), (req: AuthedRequest, res) => {
  try {
    if (!req.file) throw new Error('Aucun fichier reçu.');
    const game = setGameLogo(String(req.params.id), req.file.buffer);
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Recherche de logos via SteamGridDB (optionnelle : nécessite STEAMGRIDDB_API_KEY)
async function steamGridDb(pathname: string): Promise<any> {
  let r: globalThis.Response;
  try {
    r = await fetch(`https://www.steamgriddb.com/api/v2${pathname}`, {
      headers: { Authorization: `Bearer ${STEAMGRIDDB_API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error('SteamGridDB injoignable depuis le serveur. Colle une URL ou téléverse une image à la place.');
  }
  if (r.status === 401 || r.status === 403) throw new Error('Clé SteamGridDB refusée : vérifie STEAMGRIDDB_API_KEY.');
  if (r.status === 404) return { data: [] };
  if (!r.ok) throw new Error(`SteamGridDB indisponible (HTTP ${r.status}).`);
  return r.json();
}

function requireLogoSearch(_req: Request, res: Response, next: NextFunction): void {
  if (!STEAMGRIDDB_API_KEY) {
    res.status(501).json({ error: 'Recherche de logos désactivée : ajoute STEAMGRIDDB_API_KEY dans .env.' });
    return;
  }
  next();
}

app.get('/api/admin/logo-search', requireAdmin, requireLogoSearch, async (req: AuthedRequest, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) {
      res.json({ results: [] });
      return;
    }
    const data = await steamGridDb(`/search/autocomplete/${encodeURIComponent(q)}`);
    const results = (data.data || []).slice(0, 8).map((g: any) => ({
      id: g.id,
      name: g.name,
      year: g.release_date ? new Date(g.release_date * 1000).getFullYear() : null,
      verified: Boolean(g.verified),
    }));
    res.json({ results });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/admin/logo-search/:sgdbId/images', requireAdmin, requireLogoSearch, async (req: AuthedRequest, res) => {
  try {
    const sgdbId = Number.parseInt(String(req.params.sgdbId), 10);
    if (!Number.isFinite(sgdbId)) throw new Error('Identifiant invalide.');
    const type = req.query.type === 'logos' ? 'logos' : 'icons';
    const data = await steamGridDb(`/${type}/game/${sgdbId}?nsfw=false&humor=false`);
    const images = (data.data || [])
      .filter((i: any) => ['image/png', 'image/jpeg', 'image/webp'].includes(i.mime))
      .slice(0, 24)
      .map((i: any) => ({ id: i.id, url: i.url, thumb: i.thumb, width: i.width, height: i.height }));
    res.json({ images });
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Importe une image SteamGridDB et l'héberge localement (pas de hotlink : le logo survit si la source disparaît).
// Seul le CDN SteamGridDB est autorisé, pour éviter que le serveur aille chercher n'importe quelle URL.
app.post('/api/admin/games/:id/logo-import', requireAdmin, requireLogoSearch, async (req: AuthedRequest, res) => {
  try {
    let url: URL;
    try {
      url = new URL(String(req.body?.url || ''));
    } catch {
      throw new Error('URL invalide.');
    }
    if (url.protocol !== 'https:' || !/(^|\.)steamgriddb\.com$/.test(url.hostname)) {
      throw new Error('Seules les images du CDN SteamGridDB peuvent être importées.');
    }
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Téléchargement impossible (HTTP ${r.status}).`);
    if (Number(r.headers.get('content-length') || 0) > 2 * 1024 * 1024) throw new Error('Image trop lourde (2 Mo max).');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) throw new Error('Image trop lourde (2 Mo max).');
    const game = setGameLogo(String(req.params.id), buf);
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/quests', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const quest = createQuest(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, quest });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/quests/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const quest = updateQuest(db, String(req.params.id), req.body || {});
    catalogChanged();
    res.json({ ok: true, quest });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/quests/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteQuest(db, String(req.params.id));
    catalogChanged();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// Sauvegarde à chaud de la base SQLite (.sqlite) sans interrompre le serveur
app.get('/api/admin/backup/sqlite', requireAdmin, async (_req: AuthedRequest, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpBackupPath = path.join(replaysDir, `hgw-backup-${stamp}.sqlite`);
    await db.backup(tmpBackupPath);
    const fileBuf = fs.readFileSync(tmpBackupPath);
    try {
      fs.unlinkSync(tmpBackupPath);
    } catch {
      // ignore unlink error
    }
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="hgw-backup-${stamp.slice(0, 10)}.sqlite"`);
    res.send(fileBuf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur lors de la sauvegarde SQLite.' });
  }
});

// Export JSON intégral (audit / archivage de l'event)
app.get('/api/admin/backup/json', requireAdmin, (_req: AuthedRequest, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date().toISOString(),
    eventSettings: getEventSettings(db),
    leaderboard: getGlobalLeaderboard(db),
    users: db.prepare(`SELECT * FROM users`).all(),
    pointsLedger: db.prepare(`SELECT * FROM points_ledger ORDER BY id ASC`).all(),
    tmnfSubmissions: db.prepare(`SELECT * FROM tmnf_submissions ORDER BY id ASC`).all(),
    tournamentRegistrations: db.prepare(`SELECT * FROM tournament_registrations`).all(),
    dailyAssignments: db.prepare(`SELECT * FROM daily_assignments ORDER BY id ASC`).all(),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hgw-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Seeder de démonstration en 1 clic pour peupler 12 joueurs, des médailles TMNF, des équipes RL Chapeaux et des preuves
app.post('/api/admin/seed-demo', requireDevMode, requireAdmin, (_req: AuthedRequest, res) => {
  const demoRoster = [
    { id: 'demo_hextaz', name: 'Hextaz', pool: 1, games: ['rocket_league', 'tmnf', 'valorant', 'cod'], tmMs: 41890 },
    { id: 'demo_kaydop', name: 'ZenithRL', pool: 1, games: ['rocket_league', 'brawlhalla', 'fall_guys', 'tmnf'], tmMs: 42120 },
    { id: 'demo_nyx', name: 'NyxShadow', pool: 1, games: ['valorant', 'cod', 'splatoon', 'pokemon'], tmMs: 42450 },
    { id: 'demo_kora', name: 'Kora', pool: 1, games: ['splatoon', 'wii_sports', 'pokemon', 'fall_guys'], tmMs: 43100 },
    { id: 'demo_maverick', name: 'Maverick', pool: 2, games: ['rocket_league', 'cod', 'tmnf', 'geometry_dash'], tmMs: 43800 },
    { id: 'demo_sora', name: 'Sora', pool: 2, games: ['pokemon', 'brawlhalla', 'wii_sports', 'splatoon'], tmMs: 44600 },
    { id: 'demo_pixel', name: 'Pixel', pool: 2, games: ['geometry_dash', 'tmnf', 'valorant', 'fall_guys'], tmMs: 45200 },
    { id: 'demo_volt', name: 'Volt', pool: 2, games: ['rocket_league', 'brawlhalla', 'cod', 'valorant'], tmMs: 46100 },
    { id: 'demo_luma', name: 'Luma', pool: 3, games: ['fall_guys', 'wii_sports', 'pokemon', 'splatoon'], tmMs: 47900 },
    { id: 'demo_echo', name: 'Echo', pool: 3, games: ['wii_sports', 'fall_guys', 'rocket_league', 'pokemon'], tmMs: 49300 },
    { id: 'demo_nova', name: 'Nova', pool: 3, games: ['splatoon', 'pokemon', 'geometry_dash', 'fall_guys'], tmMs: 51200 },
    { id: 'demo_blitz', name: 'Blitz', pool: 3, games: ['brawlhalla', 'fall_guys', 'wii_sports', 'tmnf'], tmMs: 53400 },
  ];

  const weeklyMap = db.prepare(`SELECT * FROM tmnf_maps WHERE is_weekly = 1 LIMIT 1`).get() as any;
  const medal1 = db.prepare(`SELECT * FROM tmnf_maps WHERE id = 'medal_1'`).get() as any;
  const medal2 = db.prepare(`SELECT * FROM tmnf_maps WHERE id = 'medal_2'`).get() as any;
  const currentSettings = getEventSettings(db);

  for (const p of demoRoster) {
    db.prepare(
      `INSERT INTO users (id, username, display_name, is_admin)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(id) DO NOTHING`
    ).run(p.id, p.name.toLowerCase(), p.name);

    saveUserSelectedGames(db, p.id, p.games);
    const quests = drawDailyQuestsForUser(db, p.id);

    // Valider 1 ou 2 défis pour alimenter le classement et laisser 1 preuve en attente pour la démo admin
    if (quests[0] && quests[0].status === 'open') {
      submitDailyProof(db, {
        userId: p.id,
        assignmentId: quests[0].id,
        proofUrl: 'https://medal.tv/games/rocket-league/clips/hgw-demo-clip',
        proofNote: `Run validé par ${p.name} !`,
      });
      if (p.pool !== 3) {
        reviewDailyAssignment(db, {
          assignmentId: quests[0].id,
          action: 'approve',
          reviewerId: 'Hextaz (AutoDemo)',
        });
      }
    }

    // Inscrire tout le monde à RL Rumble (avec leur Chapeau 1/2/3) et Fall Guys
    for (const tid of ['rl_rumble', 'brawlhalla', 'tmnf_cup', 'fall_guys']) {
      db.prepare(
        `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(tournament_id, user_id) DO UPDATE SET pool = excluded.pool, checked_in = 1`
      ).run(tid, p.id, p.pool);
    }

    // Soumettre des replays sur A01-Race et A02-Race (et sur la Map Serveur 24/7 si Semaine 2 est ouverte)
    const existingSub = db
      .prepare(`SELECT COUNT(*) AS cnt FROM tmnf_submissions WHERE user_id = ?`)
      .get(p.id) as { cnt: number };

    if (existingSub.cnt === 0 && medal1) {
      const bufMedal1 = buildSampleReplayGbx({
        mapUid: medal1.uid,
        bestTimeMs: medal1.author_ms + (p.pool - 1) * 900,
        playerLogin: p.name.toLowerCase(),
        playerNickname: p.name,
        nonce: `medal1_${p.id}`,
      });
      submitTmnfReplay(db, {
        userId: p.id,
        buffer: bufMedal1,
        fileName: `${p.name}_A01.Replay.gbx`,
      });

      if (medal2) {
        const bufMedal2 = buildSampleReplayGbx({
          mapUid: medal2.uid,
          bestTimeMs: medal2.author_ms + (p.pool - 1) * 700,
          playerLogin: p.name.toLowerCase(),
          playerNickname: p.name,
          nonce: `medal2_${p.id}`,
        });
        submitTmnfReplay(db, {
          userId: p.id,
          buffer: bufMedal2,
          fileName: `${p.name}_A02.Replay.gbx`,
        });
      }

      if (weeklyMap && currentSettings.tmnf_weekly_unlocked) {
        const bufWeekly = buildSampleReplayGbx({
          mapUid: weeklyMap.uid,
          bestTimeMs: p.tmMs,
          playerLogin: p.name.toLowerCase(),
          playerNickname: p.name,
          nonce: `weekly_${p.id}`,
        });
        submitTmnfReplay(db, {
          userId: p.id,
          buffer: bufWeekly,
          fileName: `${p.name}_weekly.Replay.gbx`,
        });
      }
    }
  }

  // Tirer les équipes équilibrées RL Rumble
  generateBalancedTeams(db, 'rl_rumble', true);

  res.json({ ok: true, message: '12 joueurs de démo, chronos TMNF, preuves et équipes Chapeaux générés !' });
});

// Cron de 03h00 Europe/Paris (Décision D1/D5/D10)
cron.schedule(
  '0 3 * * *',
  () => {
    console.log('⏰ [Cron 03:00 Europe/Paris] Exécution du tirage quotidien des défis HGW...');
    const res = runNightlyDailyReset(db);
    console.log(
      `✅ [Cron 03:00] ${res.expiredCount} défis expirés, ${res.usersProcessed} joueurs traités, ${res.questsAssigned} défis actifs.`
    );
  },
  { timezone: 'Europe/Paris' }
);

// Fallback SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, HOST, async () => {
  console.log(`🚀 [HGW Event] Serveur Web actif sur http://${HOST}:${PORT}`);
  await bot.start();
});
