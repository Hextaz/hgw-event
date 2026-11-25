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
import {
  createGame,
  createQuest,
  deleteGame,
  deleteQuest,
  exportCatalog,
  importCatalog,
  listCatalog,
  updateGame,
  updateQuest,
} from './catalog.js';
import { getEventConfig, updateEventConfig } from './config.js';
import { initDb } from './db.js';
import {
  archiveCurrentEdition,
  deleteArchivedEdition,
  listArchivedEditions,
  startNewEdition,
} from './editions.js';
import {
  drawDailyQuestsForUser,
  getGlobalLeaderboard,
  getParisDayAndWeekKey,
  grantManualPoints,
  recalculateUserRegularityBonuses,
  rerollDailyAssignment,
  reviewDailyAssignment,
  runNightlyDailyReset,
  saveUserSelectedGames,
  submitDailyProof,
} from './engine.js';
import {
  createFeaturedItem,
  deleteFeaturedItem,
  getFeaturedItemLeaderboard,
  getUserFeaturedSummary,
  listFeaturedItems,
  listPendingFeaturedProofs,
  recalculateFeaturedLadder,
  recordTmnfLiveServerFinish,
  reviewFeaturedSubmission,
  submitFeaturedStandard,
  submitTmnfReplay,
  updateFeaturedItem,
} from './featured.js';
import { buildSampleReplayGbx, parseChallengeGbx } from './gbx.js';
import {
  createTournament,
  deleteTournament,
  generateBalancedTeams,
  listTournamentsWithRegistrations,
  recordTournamentPlacements,
  updateTournament,
  updateTournamentPlayer,
  updateTournamentRoundScores,
} from './tournaments.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hgw-dev-secret-change-in-production-2026';
const COOKIE_NAME = 'hgw_session';

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
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
    res.status(403).json({ error: 'Accès réservé aux administrateurs.' });
    return;
  }
  next();
}

app.use(attachUser);

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

function isValidMediaMagicBytes(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
    if (bytesRead < 4) return false;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return true;
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
    if (head.subarray(0, 4).toString('ascii') === 'GIF8') return true;
    if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return true;
    if (head.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true;
    return false;
  } catch {
    return false;
  }
}

const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, proofsDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(ext) ? ext : '.bin';
      cb(null, `proof_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

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

    if (!tokenRes.ok) throw new Error(`Discord token error: ${tokenRes.status}`);
    const tokenData = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Discord user error: ${userRes.status}`);
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
    ).run(discordUser.id, discordUser.username, discordUser.global_name || discordUser.username, avatarUrl, isAdmin);

    const token = signSessionToken(discordUser.id);
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 14 * 24 * 3600 * 1000 });
    res.redirect('/');
  } catch (err: any) {
    console.error('❌ [OAuth2] Erreur callback Discord:', err?.message || err);
    res.redirect('/?error=oauth_failed');
  }
});

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
  res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: 14 * 24 * 3600 * 1000 });
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  res.json({ ok: true, user });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ============================================================================
// ÉTAT GLOBAL, HALL OF FAME & PROFIL JOUEUR
// ============================================================================

app.get('/api/state', (req: AuthedRequest, res) => {
  const { dayKey, weekKey } = getParisDayAndWeekKey();
  const eventConfig = getEventConfig(db);
  const games = db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM quests q WHERE q.game_id = g.id AND q.active = 1) AS active_quest_count
       FROM games g ORDER BY g.sort_order ASC`
    )
    .all();

  const leaderboard = getGlobalLeaderboard(db);
  const featuredLadder = recalculateFeaturedLadder(db);
  const featuredItems = listFeaturedItems(db, false);
  const tournaments = listTournamentsWithRegistrations(db, false);
  const archivedEditions = listArchivedEditions(db);

  const recentFeed = db
    .prepare(
      `SELECT pl.*, u.display_name, u.avatar
       FROM points_ledger pl
       JOIN users u ON u.id = pl.user_id
       ORDER BY pl.updated_at DESC, pl.id DESC
       LIMIT 25`
    )
    .all();

  let mySelectedGames: string[] = [];
  let myDailyQuests: any[] = [];
  let myWeeklyGameCounts: Record<string, number> = {};
  let myRegularity: any = {
    activeDaysCount: 0,
    totalBonusPoints: 0,
    tiers: eventConfig.regularity_tiers.map((t) => ({ days: t.days, points: t.points, unlocked: false })),
  };
  let myFeaturedSubmissions: any[] = [];
  let myLedger: any[] = [];
  let canRerollToday = false;

  if (req.user) {
    mySelectedGames = (
      db.prepare(`SELECT game_id FROM user_games WHERE user_id = ?`).all(req.user.id) as { game_id: string }[]
    ).map((r) => r.game_id);

    if (
      mySelectedGames.length >= eventConfig.min_selected_games &&
      eventConfig.effective_phase !== 'draft' &&
      eventConfig.effective_phase !== 'closed'
    ) {
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
    for (const r of weeklyRows) myWeeklyGameCounts[r.game_id] = r.cnt;

    myFeaturedSubmissions = getUserFeaturedSummary(db, req.user.id);

    myLedger = db
      .prepare(`SELECT * FROM points_ledger WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 30`)
      .all(req.user.id);

    const usedToday = req.user.reroll_day_key === dayKey ? Number(req.user.rerolls_used || 0) : 0;
    canRerollToday = eventConfig.daily_rerolls_max > 0 && usedToday < eventConfig.daily_rerolls_max;
  }

  let adminPayload: any = null;
  if (req.user?.is_admin === 1) {
    const dailyPending = (
      db
        .prepare(
          `SELECT da.*, q.title, q.description, q.difficulty, q.points, g.name AS game_name, g.emoji AS game_emoji, u.display_name, u.username, u.avatar
           FROM daily_assignments da
           JOIN quests q ON q.id = da.quest_id
           JOIN games g ON g.id = q.game_id
           JOIN users u ON u.id = da.user_id
           WHERE da.status = 'submitted'
           ORDER BY da.submitted_at ASC`
        )
        .all() as any[]
    ).map((r) => ({ ...r, kind: 'daily' }));

    const featuredPending = listPendingFeaturedProofs(db);
    const pendingProofs = [...dailyPending, ...featuredPending].sort((a, b) =>
      String(a.submitted_at || '').localeCompare(String(b.submitted_at || ''))
    );

    const allUsers = db
      .prepare(`SELECT id, username, display_name, avatar, tmnf_login, is_admin, created_at FROM users ORDER BY is_admin DESC, display_name ASC`)
      .all();

    const allTournaments = listTournamentsWithRegistrations(db, true);
    const allFeaturedItems = listFeaturedItems(db, true);

    const totalFeaturedSubs = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM featured_submissions WHERE status = 'validated'`).get() as { cnt: number }
    ).cnt;
    const totalValidatedQuests = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM daily_assignments WHERE status = 'validated'`).get() as { cnt: number }
    ).cnt;
    const totalPoints = (
      db.prepare(`SELECT COALESCE(SUM(points), 0) AS tot FROM points_ledger`).get() as { tot: number }
    ).tot;

    adminPayload = {
      pendingProofs,
      allUsers,
      allTournaments,
      allFeaturedItems,
      stats: {
        totalUsers: allUsers.length,
        pendingProofsCount: pendingProofs.length,
        totalReplays: totalFeaturedSubs,
        totalFeaturedSubs,
        totalValidatedQuests,
        totalPoints,
        tombolaQualifiedCount: leaderboard.filter((p) => p.tombola_eligible).length,
      },
    };
  }

  res.json({
    serverTime: new Date().toISOString(),
    dayKey,
    weekKey,
    eventSettings: eventConfig,
    eventConfig,
    maxWeeklyQuestsPerGame: eventConfig.max_quests_per_game_per_act,
    minSelectedGames: eventConfig.min_selected_games,
    oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID?.trim()),
    allowDevLogin: DEV_MODE,
    devMode: DEV_MODE,
    botStatus: bot.getStatus(),
    tmnfServer: {
      login: eventConfig.featured.server_info.login,
      playitAddress: eventConfig.featured.server_info.address,
      joinUrl: eventConfig.featured.server_info.join_url,
    },
    tombolaThreshold: eventConfig.tombola_threshold,
    user: req.user || null,
    mySelectedGames,
    myDailyQuests,
    myWeeklyGameCounts,
    myRegularity,
    canRerollToday,
    myFeaturedSubmissions,
    myTmnfSubmissions: myFeaturedSubmissions,
    myLedger,
    recentFeed,
    games,
    featuredItems,
    featuredLadder,
    tmnfMaps: featuredItems,
    weeklyTmnfLeaderboard: featuredLadder,
    tournaments,
    leaderboard,
    archivedEditions,
    admin: adminPayload,
  });
});

app.get('/api/hall-of-fame', (_req, res) => {
  res.json({ ok: true, editions: listArchivedEditions(db) });
});

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

app.get('/api/player/:id/ledger', (req, res) => {
  const userId = String(req.params.id);
  const player = db
    .prepare(`SELECT id, username, display_name, avatar, tmnf_login, created_at FROM users WHERE id = ?`)
    .get(userId) as any;

  if (!player) {
    res.status(404).json({ error: 'Joueur introuvable.' });
    return;
  }

  const entries = db.prepare(`SELECT * FROM points_ledger WHERE user_id = ? ORDER BY updated_at DESC, id DESC`).all(userId);
  const selectedGames = db
    .prepare(
      `SELECT g.id, g.name, g.short_name, g.emoji
       FROM user_games ug JOIN games g ON g.id = ug.game_id
       WHERE ug.user_id = ? ORDER BY g.sort_order ASC`
    )
    .all(userId);

  res.json({ ok: true, player, selectedGames, entries });
});

app.post('/api/profile/tmnf-login', requireAuth, (req: AuthedRequest, res) => {
  const tmnfLogin = String(req.body.tmnfLogin || '').trim().slice(0, 40);
  db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(tmnfLogin || null, req.user.id);
  broadcastRealtimeEvent('profile_updated');
  res.json({ ok: true, tmnfLogin: tmnfLogin || null });
});

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

app.post('/api/quests/:id/reroll', requireAuth, (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const quests = rerollDailyAssignment(db, req.user.id, assignmentId);
    res.json({ ok: true, quests });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Reroll impossible.' });
  }
});

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

      if (proofFile && req.file?.path && !isValidMediaMagicBytes(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        res.status(400).json({
          error: 'Format de fichier non reconnu : veuillez envoyer une vraie image (PNG, JPG, WEBP, GIF) ou vidéo (MP4, WEBM).',
        });
        return;
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
// JEU VEDETTE — CONNECTEUR STANDARD + CONNECTEUR TRACKMANIA (.Replay.gbx)
// ============================================================================

app.post(
  '/api/featured/:itemId/submit',
  requireAuth,
  createRateLimiter(20, 60_000),
  proofUpload.single('proofFile'),
  async (req: AuthedRequest, res) => {
    try {
      const itemId = String(req.params.itemId);
      const proofUrl = typeof req.body.proofUrl === 'string' ? req.body.proofUrl.trim() : '';
      const proofNote = typeof req.body.proofNote === 'string' ? req.body.proofNote.trim() : '';
      const proofFile = req.file?.filename;
      const metricValue = req.body.metricValue !== undefined ? Number(req.body.metricValue) : undefined;

      if (proofFile && req.file?.path && !isValidMediaMagicBytes(req.file.path)) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        res.status(400).json({
          error: 'Format de fichier non reconnu : envoyez une vraie image (PNG, JPG, WEBP, GIF) ou vidéo (MP4, WEBM).',
        });
        return;
      }

      const sub = submitFeaturedStandard(db, {
        userId: req.user.id,
        itemId,
        metricValue,
        proofUrl: proofUrl || undefined,
        proofFile,
        proofNote: proofNote || undefined,
      });

      await bot.notifyFeaturedProofSubmitted(sub);
      broadcastRealtimeEvent('featured_updated', `⭐ ${req.user.display_name} a soumis une preuve sur ${sub.item_code}`);
      res.json({ ok: true, submission: sub });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Échec de la soumission.' });
    }
  }
);

app.get('/api/featured/:itemId/leaderboard', (req, res) => {
  try {
    const data = getFeaturedItemLeaderboard(db, String(req.params.itemId));
    res.json({ ok: true, ...data });
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Épreuve introuvable.' });
  }
});

// Routes Trackmania (.Replay.gbx + Ghost + XML-RPC Webhook)
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
        const out = submitTmnfReplay(db, { userId: req.user.id, buffer: file.buffer, fileName: safeReplayName });
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
        results.push({ fileName: file.originalname, ok: false, error: err.message || 'Fichier .gbx invalide.' });
      }
    }

    if (validCount > 0) {
      broadcastRealtimeEvent(
        'tmnf_replay',
        `🏎️ ${req.user.display_name} a validé ${validCount} replay(s) Trackmania${totalDeltaPoints > 0 ? ` (+${totalDeltaPoints} pts)` : ''} !`
      );
    }

    res.json({ ok: validCount > 0, validCount, errorCount, totalDeltaPoints, results });
  }
);

app.get('/api/tmnf/map/:mapId/leaderboard', (req, res) => {
  try {
    const data = getFeaturedItemLeaderboard(db, String(req.params.mapId));
    res.json({ ok: true, ...data });
  } catch (err: any) {
    res.status(404).json({ error: err.message || 'Piste introuvable.' });
  }
});

app.get('/api/tmnf/map/:mapId/ghost/:userId', (req, res) => {
  try {
    const mapId = String(req.params.mapId);
    const userId = String(req.params.userId);
    const data = getFeaturedItemLeaderboard(db, mapId);
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

app.post('/api/tmnf/webhook', (req: AuthedRequest, res) => {
  const configuredSecret = process.env.TMNF_WEBHOOK_SECRET?.trim();
  const headerSecret = String(req.headers['x-tmnf-secret'] || '');
  const isAdminSession = req.user?.is_admin === 1;
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
        `🏁 [Serveur Live] ${out.matchedUser.display_name} vient de rouler ${out.formattedTime} sur ${out.map.code}${out.deltaPoints > 0 ? ` (+${out.deltaPoints} pts)` : ' (Nouveau PB !)'}`
      );
    }
    res.json({ ok: true, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Erreur webhook TMNF.' });
  }
});

app.get('/api/tmnf/sample-replay/:mapId', requireDevMode, requireAuth, (req: AuthedRequest, res) => {
  const items = listFeaturedItems(db, true);
  const map = items.find((m) => m.id === String(req.params.mapId));
  if (!map) {
    res.status(404).json({ error: 'Piste introuvable.' });
    return;
  }
  const baseMs = map.author_ms || 30000;
  const sampleTime = Math.max(5000, baseMs - Math.floor(Math.random() * 350) - 40);
  const login = req.user.tmnf_login || req.user.username || 'hgw_pilot';
  const buf = buildSampleReplayGbx({
    mapUid: map.uid || map.external_uid || map.id,
    bestTimeMs: sampleTime,
    playerLogin: login,
    playerNickname: req.user.display_name,
    nonce: `${Date.now()}_${req.user.id}`,
  });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${map.code}_${login}_${sampleTime}ms.Replay.gbx"`);
  res.send(buf);
});

// ============================================================================
// TOURNOIS LIVE (INSCRIPTION JOUEUR)
// ============================================================================

app.post('/api/tournaments/:id/toggle', requireAuth, (req: AuthedRequest, res) => {
  const tournamentId = String(req.params.id);
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ? AND active = 1`).get(tournamentId);
  if (!tournament) {
    res.status(404).json({ error: 'Tournoi introuvable.' });
    return;
  }

  const existing = db
    .prepare(`SELECT * FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`)
    .get(tournamentId, req.user.id);

  if (existing) {
    db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`).run(tournamentId, req.user.id);
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, registered: false });
  } else {
    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, ?, 2, 0)`).run(
      tournamentId,
      req.user.id
    );
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, registered: true });
  }
});

// ============================================================================
// BACK-OFFICE ADMIN — MODÉRATION UNIFIÉE, CONFIG, JEU VEDETTE, TOURNOIS, ÉDITIONS
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
      action === 'approve' ? `✅ ${updated.display_name} a validé "${updated.title}" (+${updated.points} pts)` : undefined
    );
    res.json({ ok: true, assignment: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/featured/submissions/:id/review', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const submissionId = Number.parseInt(String(req.params.id), 10);
    const action = req.body.action === 'reject' ? 'reject' : 'approve';
    const rejectReason = typeof req.body.rejectReason === 'string' ? req.body.rejectReason.trim() : undefined;
    if (action === 'reject' && !rejectReason) {
      res.status(400).json({ error: 'Un motif de refus est obligatoire.' });
      return;
    }

    const updated = reviewFeaturedSubmission(db, {
      submissionId,
      action,
      reviewerId: req.user.display_name,
      rejectReason,
    });
    broadcastRealtimeEvent(
      'points_updated',
      action === 'approve'
        ? `⭐ ${updated.display_name} a validé ${updated.item_code} · ${updated.item_name}${updated.points_awarded > 0 ? ` (+${updated.points_awarded} pts)` : ''}`
        : undefined
    );
    res.json({ ok: true, submission: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Configuration complète d'édition (nouveau + alias legacy /api/admin/settings)
const handleConfigUpdate = (req: AuthedRequest, res: Response) => {
  try {
    const updated = updateEventConfig(db, req.body || {});
    broadcastRealtimeEvent('settings_updated', '⚙️ Configuration de l’édition mise à jour !');
    res.json({ ok: true, eventSettings: updated, eventConfig: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
app.post('/api/admin/settings', requireAdmin, handleConfigUpdate);
app.post('/api/admin/config', requireAdmin, handleConfigUpdate);

// Admin : Jeu Vedette (CRUD épreuves + import .Challenge.gbx / .Replay.gbx)
app.get('/api/admin/featured', requireAdmin, (_req: AuthedRequest, res) => {
  res.json({ ok: true, config: getEventConfig(db).featured, items: listFeaturedItems(db, true) });
});

app.post('/api/admin/featured/config', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const updated = updateEventConfig(db, { featured: req.body || {} });
    recalculateFeaturedLadder(db);
    broadcastRealtimeEvent('featured_updated', '⭐ Configuration du jeu vedette mise à jour !');
    res.json({ ok: true, featured: updated.featured, eventConfig: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/featured/parse-gbx', requireAdmin, gbxUpload.single('file'), (req: AuthedRequest, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400).json({ error: 'Veuillez sélectionner un fichier .Challenge.gbx ou .Replay.gbx.' });
    return;
  }
  const parsed = parseChallengeGbx(req.file.buffer);
  if (!parsed.valid) {
    res.status(400).json({ error: parsed.error || 'Fichier GBX illisible.' });
    return;
  }
  res.json({ ok: true, parsed });
});

app.post('/api/admin/featured/items', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const item = createFeaturedItem(db, req.body || {});
    broadcastRealtimeEvent('featured_updated');
    res.json({ ok: true, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/featured/items/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const item = updateFeaturedItem(db, String(req.params.id), req.body || {});
    broadcastRealtimeEvent('featured_updated');
    res.json({ ok: true, item });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/featured/items/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteFeaturedItem(db, String(req.params.id));
    broadcastRealtimeEvent('featured_updated');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// Admin : Tournois (CRUD + Gestion live)
app.post('/api/admin/tournaments', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournament = createTournament(db, req.body || {});
    broadcastRealtimeEvent('tournament_updated', `🏆 Nouveau tournoi ajouté : ${tournament.name}`);
    res.json({ ok: true, tournament });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/admin/tournaments/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournament = updateTournament(db, String(req.params.id), req.body || {});
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, tournament });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/tournaments/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteTournament(db, String(req.params.id));
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/admin/tournaments/:id/player', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournamentId = String(req.params.id);
    const { userId, pool, checkedIn, teamNumber, teamName } = req.body;
    updateTournamentPlayer(db, tournamentId, { userId: String(userId), pool, checkedIn, teamNumber, teamName });
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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

app.post('/api/admin/tournaments/:id/rounds', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournamentId = String(req.params.id);
    const rawScores = Array.isArray(req.body.scores) ? req.body.scores : [];
    const normalized = rawScores.map((s: any) => ({
      userId: String(s.userId),
      scores: Array.isArray(s.scores) ? s.scores : Array.isArray(s.shows) ? s.shows : [],
    }));
    const updated = updateTournamentRoundScores(db, tournamentId, normalized);
    broadcastRealtimeEvent('points_updated', '🏆 Scores des manches mis à jour !');
    res.json({ ok: true, standings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Alias rétrocompatible Fall Guys
app.post('/api/admin/fall-guys/scores', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const rawScores = Array.isArray(req.body.scores) ? req.body.scores : [];
    const updated = updateTournamentRoundScores(
      db,
      'fall_guys',
      rawScores.map((s: any) => ({ userId: String(s.userId), scores: Array.isArray(s.shows) ? s.shows : [] }))
    );
    broadcastRealtimeEvent('points_updated', '🫘 Scores Fall Guys mis à jour en direct !');
    res.json({ ok: true, standings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Admin : Éditions & Hall of Fame
app.post('/api/admin/editions/archive', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const out = archiveCurrentEdition(db, {
      leaderboard: getGlobalLeaderboard(db),
      customName: typeof req.body?.name === 'string' ? req.body.name : undefined,
    });
    broadcastRealtimeEvent('settings_updated', `🏛️ Édition « ${out.name} » archivée dans le Hall of Fame !`);
    res.json({ ok: true, archive: out });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/editions/new', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const out = startNewEdition(db, {
      newName: String(req.body?.newName || ''),
      leaderboard: getGlobalLeaderboard(db),
      archiveCurrent: req.body?.archiveCurrent !== false,
      keepTournaments: req.body?.keepTournaments !== false,
      keepFeaturedItems: req.body?.keepFeaturedItems !== false,
    });
    broadcastRealtimeEvent('settings_updated', `🚀 Nouvelle édition « ${out.eventConfig.event_name} » créée en mode préparation.`);
    res.json({ ok: true, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/editions/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteArchivedEdition(db, String(req.params.id));
    broadcastRealtimeEvent('settings_updated');
    res.json({ ok: true });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// Admin : Gestion des rôles Admin depuis l'UI
app.post('/api/admin/users/:id/admin', requireAdmin, (req: AuthedRequest, res) => {
  const targetId = String(req.params.id);
  const nextAdmin = req.body?.isAdmin ? 1 : 0;
  const target = db.prepare(`SELECT id, display_name, is_admin FROM users WHERE id = ?`).get(targetId) as any;
  if (!target) {
    res.status(404).json({ error: 'Utilisateur introuvable.' });
    return;
  }
  if (nextAdmin === 0 && target.is_admin === 1) {
    const adminsCount = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`).get() as { c: number }).c;
    if (adminsCount <= 1) {
      res.status(400).json({ error: 'Impossible de retirer les droits du dernier administrateur.' });
      return;
    }
  }
  db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(nextAdmin, targetId);
  broadcastRealtimeEvent('profile_updated');
  res.json({ ok: true, userId: targetId, is_admin: nextAdmin });
});

app.post('/api/admin/cron/trigger', requireAdmin, (_req: AuthedRequest, res) => {
  const result = runNightlyDailyReset(db);
  broadcastRealtimeEvent('daily_reset', '⏰ Nouveaux défis quotidiens générés !');
  res.json({ ok: true, ...result });
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
  const cfg = getEventConfig(db);
  const lb = getGlobalLeaderboard(db);
  const qualified = lb.filter((p) => p.tombola_eligible);
  if (qualified.length === 0) {
    res.status(400).json({ error: `Aucun joueur n’a encore atteint le seuil de ${cfg.tombola_threshold} pts pour la Tombola.` });
    return;
  }
  const idx = crypto.randomInt(0, qualified.length);
  const winner = qualified[idx];

  // Mémoriser le gagnant pour l'archivage Hall of Fame
  db.prepare(
    `INSERT INTO event_settings (key, value, updated_at) VALUES ('last_tombola_winner_json', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(JSON.stringify({ id: winner.id, display_name: winner.display_name, total_points: winner.total_points }));

  broadcastRealtimeEvent(
    'tombola_winner',
    `🎟️ TIRAGE TOMBOLA : Félicitations à ${winner.display_name} (${winner.total_points} pts) qui remporte la Grande Tombola !`,
    { winner, candidates: qualified, eligibleCount: qualified.length }
  );
  res.json({ ok: true, winner, candidates: qualified, eligibleCount: qualified.length });
});

// ============================================================================
// CATALOGUE JEUX & DÉFIS (CRUD + LOGOS + IMPORT / EXPORT JSON)
// ============================================================================

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

app.get('/api/admin/catalog/export', requireAdmin, (req: AuthedRequest, res) => {
  const gameId = typeof req.query.gameId === 'string' && req.query.gameId.trim() ? req.query.gameId.trim() : undefined;
  const data = exportCatalog(db, gameId);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hgw-catalog${gameId ? `-${gameId}` : ''}-${stamp}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/admin/catalog/import', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const out = importCatalog(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
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

// Sauvegardes & Export JSON
app.get('/api/admin/backup/sqlite', requireAdmin, async (_req: AuthedRequest, res) => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const tmpBackupPath = path.join(replaysDir, `hgw-backup-${stamp}.sqlite`);
    await db.backup(tmpBackupPath);
    const fileBuf = fs.readFileSync(tmpBackupPath);
    try {
      fs.unlinkSync(tmpBackupPath);
    } catch {}
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="hgw-backup-${stamp.slice(0, 10)}.sqlite"`);
    res.send(fileBuf);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erreur lors de la sauvegarde SQLite.' });
  }
});

app.get('/api/admin/backup/json', requireAdmin, (_req: AuthedRequest, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date().toISOString(),
    eventConfig: getEventConfig(db),
    leaderboard: getGlobalLeaderboard(db),
    users: db.prepare(`SELECT * FROM users`).all(),
    pointsLedger: db.prepare(`SELECT * FROM points_ledger ORDER BY id ASC`).all(),
    featuredItems: db.prepare(`SELECT * FROM featured_items ORDER BY sort_order ASC`).all(),
    featuredSubmissions: db.prepare(`SELECT * FROM featured_submissions ORDER BY id ASC`).all(),
    tournaments: db.prepare(`SELECT * FROM tournaments ORDER BY sort_order ASC`).all(),
    tournamentRegistrations: db.prepare(`SELECT * FROM tournament_registrations`).all(),
    dailyAssignments: db.prepare(`SELECT * FROM daily_assignments ORDER BY id ASC`).all(),
    archivedEditions: listArchivedEditions(db),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hgw-export-${stamp}.json"`);
  res.send(JSON.stringify(payload, null, 2));
});

// Seeder de démonstration (mode dev uniquement)
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

  const items = listFeaturedItems(db, false);
  const weeklyMap = items.find((m) => m.is_ladder);
  const medal1 = items.find((m) => !m.is_ladder);
  const medal2 = items.filter((m) => !m.is_ladder)[1];
  const currentConfig = getEventConfig(db);
  const activeTournaments = listTournamentsWithRegistrations(db, false);

  for (const p of demoRoster) {
    db.prepare(`INSERT INTO users (id, username, display_name, is_admin) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO NOTHING`).run(
      p.id,
      p.name.toLowerCase(),
      p.name
    );

    try {
      saveUserSelectedGames(db, p.id, p.games);
      const quests = drawDailyQuestsForUser(db, p.id);
      if (quests[0] && quests[0].status === 'open') {
        submitDailyProof(db, {
          userId: p.id,
          assignmentId: quests[0].id,
          proofUrl: 'https://medal.tv/games/rocket-league/clips/hgw-demo-clip',
          proofNote: `Run validé par ${p.name} !`,
        });
        if (p.pool !== 3) {
          reviewDailyAssignment(db, { assignmentId: quests[0].id, action: 'approve', reviewerId: 'Hextaz (AutoDemo)' });
        }
      }
    } catch {
      // ignorer si catalogue personnalisé
    }

    for (const t of activeTournaments) {
      db.prepare(
        `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(tournament_id, user_id) DO UPDATE SET pool = excluded.pool, checked_in = 1`
      ).run(t.id, p.id, p.pool);
    }

    const existingSub = db
      .prepare(`SELECT COUNT(*) AS cnt FROM featured_submissions WHERE user_id = ?`)
      .get(p.id) as { cnt: number };

    if (existingSub.cnt === 0 && currentConfig.featured.enabled && currentConfig.featured.connector === 'tmnf_gbx' && medal1) {
      try {
        const bufMedal1 = buildSampleReplayGbx({
          mapUid: medal1.uid,
          bestTimeMs: (medal1.author_ms || 25000) + (p.pool - 1) * 900,
          playerLogin: p.name.toLowerCase(),
          playerNickname: p.name,
          nonce: `medal1_${p.id}`,
        });
        submitTmnfReplay(db, { userId: p.id, buffer: bufMedal1, fileName: `${p.name}_M1.Replay.gbx` });

        if (medal2) {
          const bufMedal2 = buildSampleReplayGbx({
            mapUid: medal2.uid,
            bestTimeMs: (medal2.author_ms || 20000) + (p.pool - 1) * 700,
            playerLogin: p.name.toLowerCase(),
            playerNickname: p.name,
            nonce: `medal2_${p.id}`,
          });
          submitTmnfReplay(db, { userId: p.id, buffer: bufMedal2, fileName: `${p.name}_M2.Replay.gbx` });
        }

        if (weeklyMap && currentConfig.ladder_unlocked) {
          const bufWeekly = buildSampleReplayGbx({
            mapUid: weeklyMap.uid,
            bestTimeMs: p.tmMs,
            playerLogin: p.name.toLowerCase(),
            playerNickname: p.name,
            nonce: `weekly_${p.id}`,
          });
          submitTmnfReplay(db, { userId: p.id, buffer: bufWeekly, fileName: `${p.name}_weekly.Replay.gbx` });
        }
      } catch {
        // ignorer si phase fermée
      }
    }
  }

  const teamTourney = activeTournaments.find((t) => t.team_size > 1);
  if (teamTourney) {
    try {
      generateBalancedTeams(db, teamTourney.id, true);
    } catch {}
  }

  res.json({ ok: true, message: '12 joueurs de démo, preuves et inscriptions générés !' });
});

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

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, HOST, async () => {
  console.log(`🚀 [HGW Event] Serveur Web actif sur http://${HOST}:${PORT}`);
  await bot.start();
});
