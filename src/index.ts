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
import { getEventConfig, isPlayablePhase, updateEventConfig } from './config.js';
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
  getUserActGameCounts,
  getUserRegularitySummary,
  grantManualPoints,
  recalculateAllRegularityBonuses,
  rerollDailyAssignment,
  reviewDailyAssignment,
  runNightlyDailyReset,
  saveUserSelectedGames,
  submitDailyProof,
  updateUserTmnfLogin,
} from './engine.js';
import {
  createFeaturedItem,
  deleteFeaturedItem,
  getFeaturedItemLeaderboard,
  getFeaturedLadder,
  getUserFeaturedSummary,
  listFeaturedItems,
  listPendingFeaturedProofs,
  recalculateAllFeaturedStages,
  recalculateFeaturedLadder,
  recordTmnfLiveServerFinish,
  reviewFeaturedSubmission,
  submitFeaturedStandard,
  submitTmnfReplay,
  updateFeaturedItem,
  type UserFeaturedItemSummary,
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
import {
  errorMessage,
  type DailyAssignmentDetailRow,
  type GameRow,
  type PointsLedgerRow,
  type RegularitySummary,
  type TournamentRow,
  type UserRow,
} from './types.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ENV_SESSION_SECRET = process.env.SESSION_SECRET?.trim();
const SESSION_SECRET =
  ENV_SESSION_SECRET ||
  (IS_PRODUCTION ? crypto.randomBytes(32).toString('hex') : 'hgw-dev-secret-local-only');
const COOKIE_NAME = 'hgw_session';
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;

const DEV_MODE =
  process.env.ALLOW_DEV_LOGIN === 'true' || (!IS_PRODUCTION && !process.env.DISCORD_CLIENT_ID?.trim());
if (IS_PRODUCTION && !ENV_SESSION_SECRET) {
  console.warn(
    '⚠️  SESSION_SECRET non défini en production : un secret éphémère aléatoire a été généré (les sessions expireront au redémarrage). Définissez SESSION_SECRET dans .env.'
  );
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function safeFilename(raw: string, fallback = 'file'): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || fallback;
}

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err: unknown) {
    const code = err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : '';
    if (code !== 'ENOENT') {
      console.warn(`⚠️ Impossible de supprimer le fichier temporaire ${path.basename(filePath)}:`, errorMessage(err));
    }
  }
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: IS_PRODUCTION,
  maxAge: SESSION_TTL_MS,
};

function requireDevMode(_req: Request, res: Response, next: NextFunction): void {
  if (!DEV_MODE) {
    res.status(403).json({ error: 'Fonction disponible uniquement en mode démo.' });
    return;
  }
  next();
}

// Hub Temps Réel SSE (Server-Sent Events)
const sseClients = new Set<Response>();
function broadcastRealtimeEvent(type: string, message?: string, payload?: Record<string, unknown>): void {
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
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
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
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { uid?: unknown; iat?: unknown };
    if (typeof data.uid !== 'string' || typeof data.iat !== 'number') return null;
    const age = Date.now() - data.iat;
    if (age < -60_000 || age > SESSION_TTL_MS) return null;
    return data.uid;
  } catch {
    return null;
  }
}

interface AuthedRequest extends Request {
  user?: UserRow;
}

function attachUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const uid = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  if (uid) {
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(uid) as UserRow | undefined;
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

function isDraftBlocked(req: AuthedRequest): boolean {
  const cfg = getEventConfig(db);
  return cfg.effective_phase === 'draft' && req.user?.is_admin !== 1;
}

app.use(attachUser);

const rateBuckets = new Map<string, number[]>();
function createRateLimiter(maxRequests: number, windowMs: number) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const routePattern = (req.route as { path?: string } | undefined)?.path || req.path;
    const key = `${req.user?.id || req.ip}:${req.baseUrl}${routePattern}`;
    const now = Date.now();
    if (rateBuckets.size > 500) {
      for (const [k, timestamps] of rateBuckets) {
        const fresh = timestamps.filter((ts) => now - ts < windowMs);
        if (fresh.length === 0) rateBuckets.delete(k);
        else rateBuckets.set(k, fresh);
      }
    }
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
    res.cookie(COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.redirect('/');
  } catch (err: unknown) {
    console.error('❌ [OAuth2] Erreur callback Discord:', errorMessage(err));
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
  res.cookie(COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
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
  const archivedEditions = listArchivedEditions(db);

  // Isolation stricte de la phase Préparation (draft) pour les visiteurs et joueurs non-admin
  if (eventConfig.effective_phase === 'draft' && req.user?.is_admin !== 1) {
    const publicDraftConfig = {
      event_name: eventConfig.event_name,
      event_subtitle: eventConfig.event_subtitle,
      effective_phase: eventConfig.effective_phase,
      status_mode: eventConfig.status_mode,
      acts_count: eventConfig.acts_count,
      acts: [],
      featured: { enabled: false, title: '', connector: 'standard', stages_enabled: false, ladder_enabled: false },
    };
    res.json({
      serverTime: new Date().toISOString(),
      dayKey,
      weekKey,
      eventSettings: publicDraftConfig,
      eventConfig: publicDraftConfig,
      maxWeeklyQuestsPerGame: eventConfig.max_quests_per_game_per_act,
      minSelectedGames: eventConfig.min_selected_games,
      oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID?.trim()),
      allowDevLogin: DEV_MODE,
      devMode: DEV_MODE,
      botStatus: bot.getStatus(),
      tmnfServer: null,
      tombolaThreshold: eventConfig.tombola_threshold,
      user: req.user || null,
      mySelectedGames: [],
      myDailyQuests: [],
      myWeeklyGameCounts: {},
      myRegularity: { activeDaysCount: 0, totalBonusPoints: 0, tiers: [] },
      canRerollToday: false,
      myFeaturedSubmissions: [],
      myTmnfSubmissions: [],
      myLedger: [],
      recentFeed: [],
      games: [],
      featuredItems: [],
      featuredLadder: [],
      tmnfMaps: [],
      weeklyTmnfLeaderboard: [],
      tournaments: [],
      leaderboard: [],
      archivedEditions,
      admin: null,
    });
    return;
  }

  const games = db
    .prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM quests q WHERE q.game_id = g.id AND q.active = 1) AS active_quest_count
       FROM games g ORDER BY g.sort_order ASC`
    )
    .all() as (GameRow & { active_quest_count: number })[];

  const leaderboard = getGlobalLeaderboard(db);
  const featuredLadder = getFeaturedLadder(db);
  const featuredItems = listFeaturedItems(db, false);
  const tournaments = listTournamentsWithRegistrations(db, false);

  const recentFeed = db
    .prepare(
      `SELECT pl.*, u.display_name, u.avatar
       FROM points_ledger pl
       JOIN users u ON u.id = pl.user_id
       ORDER BY pl.updated_at DESC, pl.id DESC
       LIMIT 25`
    )
    .all() as (PointsLedgerRow & { display_name: string; avatar: string | null })[];

  let mySelectedGames: string[] = [];
  let myDailyQuests: DailyAssignmentDetailRow[] = [];
  const myWeeklyGameCounts: Record<string, number> = {};
  let myRegularity: RegularitySummary = {
    activeDaysCount: 0,
    totalBonusPoints: 0,
    tiers: eventConfig.regularity_tiers.map((t) => ({ days: t.days, points: t.points, unlocked: false })),
  };
  let myFeaturedSubmissions: UserFeaturedItemSummary[] = [];
  let myLedger: PointsLedgerRow[] = [];
  let canRerollToday = false;

  if (req.user) {
    mySelectedGames = (
      db.prepare(`SELECT game_id FROM user_games WHERE user_id = ?`).all(req.user.id) as { game_id: string }[]
    ).map((r) => r.game_id);

    if (mySelectedGames.length >= eventConfig.min_selected_games && isPlayablePhase(eventConfig.effective_phase)) {
      myDailyQuests = drawDailyQuestsForUser(db, req.user.id);
    }

    myRegularity = getUserRegularitySummary(db, req.user.id);

    const actCounts = getUserActGameCounts(db, req.user.id);
    for (const [gid, cnt] of actCounts) myWeeklyGameCounts[gid] = cnt;

    myFeaturedSubmissions = getUserFeaturedSummary(db, req.user.id);

    myLedger = db
      .prepare(`SELECT * FROM points_ledger WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 30`)
      .all(req.user.id) as PointsLedgerRow[];

    const usedToday = req.user.reroll_day_key === dayKey ? Number(req.user.rerolls_used || 0) : 0;
    canRerollToday =
      isPlayablePhase(eventConfig.effective_phase) &&
      eventConfig.daily_rerolls_max > 0 &&
      usedToday < eventConfig.daily_rerolls_max;
  }

  let adminPayload: Record<string, unknown> | null = null;
  if (req.user?.is_admin === 1) {
    const dailyPending = (
      db
        .prepare(
          `SELECT da.*, q.title, q.description, q.difficulty, q.points, q.game_id, g.name AS game_name, g.emoji AS game_emoji, u.display_name, u.username, u.avatar
           FROM daily_assignments da
           JOIN quests q ON q.id = da.quest_id
           JOIN games g ON g.id = q.game_id
           JOIN users u ON u.id = da.user_id
           WHERE da.status = 'submitted'
           ORDER BY da.submitted_at ASC`
        )
        .all() as DailyAssignmentDetailRow[]
    ).map((r) => ({ ...r, kind: 'daily' as const }));

    const featuredPending = listPendingFeaturedProofs(db);
    const pendingProofs = [...dailyPending, ...featuredPending].sort((a, b) =>
      String(a.submitted_at || '').localeCompare(String(b.submitted_at || ''))
    );

    const allUsers = db
      .prepare(`SELECT id, username, display_name, avatar, tmnf_login, is_admin, created_at FROM users ORDER BY is_admin DESC, display_name ASC`)
      .all() as Omit<UserRow, 'reroll_day_key' | 'rerolls_used'>[];

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

app.get('/api/player/:id/ledger', (req: AuthedRequest, res) => {
  if (isDraftBlocked(req)) {
    res.status(403).json({ error: 'L’édition est en cours de préparation.' });
    return;
  }
  const userId = String(req.params.id);
  const player = db
    .prepare(`SELECT id, username, display_name, avatar, tmnf_login, created_at FROM users WHERE id = ?`)
    .get(userId) as Omit<UserRow, 'is_admin' | 'reroll_day_key' | 'rerolls_used'> | undefined;

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
  try {
    const saved = updateUserTmnfLogin(db, req.user!.id, req.body?.tmnfLogin, {
      isAdmin: req.user!.is_admin === 1,
    });
    broadcastRealtimeEvent('profile_updated');
    res.json({ ok: true, tmnfLogin: saved });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err, 'Impossible de lier ce login Trackmania.') });
  }
});

app.post('/api/profile/games', requireAuth, (req: AuthedRequest, res) => {
  try {
    const gameIds = Array.isArray(req.body.gameIds) ? req.body.gameIds.map(String) : [];
    const tmnfLogin = typeof req.body.tmnfLogin === 'string' ? req.body.tmnfLogin : undefined;
    if (tmnfLogin !== undefined) {
      updateUserTmnfLogin(db, req.user!.id, tmnfLogin, { isAdmin: req.user!.is_admin === 1 });
    }
    const result = saveUserSelectedGames(db, req.user!.id, gameIds);
    const quests = drawDailyQuestsForUser(db, req.user!.id);
    res.json({ ok: true, ...result, quests });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err, 'Impossible de sauvegarder vos jeux.') });
  }
});

app.post('/api/quests/:id/reroll', requireAuth, (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const quests = rerollDailyAssignment(db, req.user!.id, assignmentId);
    res.json({ ok: true, quests });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err, 'Reroll impossible.') });
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
        unlinkQuietly(req.file.path);
        res.status(400).json({
          error: 'Format de fichier non reconnu : veuillez envoyer une vraie image (PNG, JPG, WEBP, GIF) ou vidéo (MP4, WEBM).',
        });
        return;
      }

      const updated = submitDailyProof(db, {
        userId: req.user!.id,
        assignmentId,
        proofUrl: proofUrl || undefined,
        proofFile,
        proofNote: proofNote || undefined,
      });

      await bot.notifyProofSubmitted(updated);
      broadcastRealtimeEvent('proof_submitted', `🕵️ ${req.user!.display_name} a soumis une preuve sur ${updated.game_name}`);
      res.json({ ok: true, assignment: updated });
    } catch (err: unknown) {
      if (req.file?.path) unlinkQuietly(req.file.path);
      res.status(400).json({ error: errorMessage(err, 'Échec de l’envoi de la preuve.') });
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
        unlinkQuietly(req.file.path);
        res.status(400).json({
          error: 'Format de fichier non reconnu : envoyez une vraie image (PNG, JPG, WEBP, GIF) ou vidéo (MP4, WEBM).',
        });
        return;
      }

      const sub = submitFeaturedStandard(db, {
        userId: req.user!.id,
        itemId,
        metricValue,
        proofUrl: proofUrl || undefined,
        proofFile,
        proofNote: proofNote || undefined,
      });

      await bot.notifyFeaturedProofSubmitted(sub);
      broadcastRealtimeEvent('featured_updated', `⭐ ${req.user!.display_name} a soumis une preuve sur ${sub.item_code}`);
      res.json({ ok: true, submission: sub });
    } catch (err: unknown) {
      if (req.file?.path) unlinkQuietly(req.file.path);
      res.status(400).json({ error: errorMessage(err, 'Échec de la soumission.') });
    }
  }
);

app.get('/api/featured/:itemId/leaderboard', (req: AuthedRequest, res) => {
  if (isDraftBlocked(req)) {
    res.status(403).json({ error: 'L’édition est en cours de préparation.' });
    return;
  }
  try {
    const data = getFeaturedItemLeaderboard(db, String(req.params.itemId));
    res.json({ ok: true, ...data });
  } catch (err: unknown) {
    res.status(404).json({ error: errorMessage(err, 'Épreuve introuvable.') });
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
      const safeReplayName = `${Date.now()}_${safeFilename(req.user!.id, 'u')}_${crypto.randomBytes(3).toString('hex')}.Replay.gbx`;
      const result = submitTmnfReplay(db, {
        userId: req.user!.id,
        buffer: req.file.buffer,
        fileName: safeReplayName,
        explicitMapId,
      });
      fs.writeFileSync(path.join(replaysDir, safeReplayName), req.file.buffer);
      broadcastRealtimeEvent(
        'tmnf_replay',
        `🏎️ ${req.user!.display_name} a signé ${result.parsed.formattedTime} sur ${result.map.code}${result.deltaPoints > 0 ? ` (+${result.deltaPoints} pts)` : ''}`
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
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err, 'Erreur lors de la lecture du fichier .Replay.gbx.') });
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

    const results: (
      | {
          fileName: string;
          ok: true;
          mapCode: string;
          mapName: string;
          formattedTime?: string;
          medal: string;
          deltaPoints: number;
          isPersonalBest: boolean;
        }
      | { fileName: string; ok: false; error: string }
    )[] = [];
    let totalDeltaPoints = 0;
    let validCount = 0;
    let errorCount = 0;

    for (const file of files) {
      try {
        const safeReplayName = `${Date.now()}_${safeFilename(req.user!.id, 'u')}_${crypto.randomBytes(3).toString('hex')}.Replay.gbx`;
        const out = submitTmnfReplay(db, { userId: req.user!.id, buffer: file.buffer, fileName: safeReplayName });
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
      } catch (err: unknown) {
        errorCount++;
        results.push({ fileName: file.originalname, ok: false, error: errorMessage(err, 'Fichier .gbx invalide.') });
      }
    }

    if (validCount > 0) {
      broadcastRealtimeEvent(
        'tmnf_replay',
        `🏎️ ${req.user!.display_name} a validé ${validCount} replay(s) Trackmania${totalDeltaPoints > 0 ? ` (+${totalDeltaPoints} pts)` : ''} !`
      );
    }

    res.json({ ok: validCount > 0, validCount, errorCount, totalDeltaPoints, results });
  }
);

app.get('/api/tmnf/map/:mapId/leaderboard', (req: AuthedRequest, res) => {
  if (isDraftBlocked(req)) {
    res.status(403).json({ error: 'L’édition est en cours de préparation.' });
    return;
  }
  try {
    const data = getFeaturedItemLeaderboard(db, String(req.params.mapId));
    res.json({ ok: true, ...data });
  } catch (err: unknown) {
    res.status(404).json({ error: errorMessage(err, 'Piste introuvable.') });
  }
});

app.get('/api/tmnf/map/:mapId/ghost/:userId', (req: AuthedRequest, res) => {
  if (isDraftBlocked(req)) {
    res.status(403).json({ error: 'L’édition est en cours de préparation.' });
    return;
  }
  try {
    const mapId = String(req.params.mapId);
    const userId = String(req.params.userId);
    const data = getFeaturedItemLeaderboard(db, mapId);
    const entry = data.entries.find((e) => e.user_id === userId) || data.entries[0];
    if (!entry) {
      res.status(404).json({ error: 'Aucun temps enregistré sur cette piste.' });
      return;
    }

    const downloadName = `Ghost_${safeFilename(data.map.code, 'map')}_${safeFilename(entry.display_name, 'driver')}_${entry.best_time_ms}ms.Replay.gbx`;
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
  } catch (err: unknown) {
    res.status(404).json({ error: errorMessage(err, 'Ghost introuvable.') });
  }
});

app.post('/api/tmnf/webhook', (req: AuthedRequest, res) => {
  const configuredSecret = process.env.TMNF_WEBHOOK_SECRET?.trim();
  const headerSecret = String(req.headers['x-tmnf-secret'] || '');
  const isAdminSession = req.user?.is_admin === 1;
  const secretOk = Boolean(configuredSecret) && timingSafeEqualStr(headerSecret, configuredSecret!);
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err, 'Erreur webhook TMNF.') });
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
  const login = req.user!.tmnf_login || req.user!.username || 'hgw_pilot';
  const buf = buildSampleReplayGbx({
    mapUid: map.uid || map.external_uid || map.id,
    bestTimeMs: sampleTime,
    playerLogin: login,
    playerNickname: req.user!.display_name,
    nonce: `${Date.now()}_${req.user!.id}`,
  });
  const dlName = `${safeFilename(map.code, 'map')}_${safeFilename(login, 'pilot')}_${sampleTime}ms.Replay.gbx`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
  res.send(buf);
});

// ============================================================================
// TOURNOIS LIVE (INSCRIPTION JOUEUR)
// ============================================================================

app.post('/api/tournaments/:id/toggle', requireAuth, (req: AuthedRequest, res) => {
  const cfg = getEventConfig(db);
  if (cfg.effective_phase === 'draft' || cfg.effective_phase === 'closed') {
    res.status(400).json({ error: 'Les inscriptions aux tournois sont fermées pour le moment.' });
    return;
  }

  const tournamentId = String(req.params.id);
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ? AND active = 1`).get(tournamentId) as
    | TournamentRow
    | undefined;
  if (!tournament) {
    res.status(404).json({ error: 'Tournoi introuvable.' });
    return;
  }
  if (tournament.status === 'live' || tournament.status === 'completed') {
    res.status(400).json({ error: 'Ce tournoi est déjà en cours ou terminé : les inscriptions sont verrouillées.' });
    return;
  }

  const existing = db
    .prepare(`SELECT placement, points_awarded FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`)
    .get(tournamentId, req.user!.id) as { placement: number | null; points_awarded: number } | undefined;

  if (existing) {
    if (existing.placement !== null || existing.points_awarded > 0) {
      res.status(400).json({ error: 'Impossible de se désinscrire : des résultats sont déjà enregistrés.' });
      return;
    }
    db.prepare(`DELETE FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`).run(tournamentId, req.user!.id);
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, registered: false });
  } else {
    db.prepare(`INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, ?, 2, 0)`).run(
      tournamentId,
      req.user!.id
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
      reviewerId: req.user!.display_name,
      rejectReason,
    });
    broadcastRealtimeEvent(
      'points_updated',
      action === 'approve' ? `✅ ${updated.display_name} a validé "${updated.title}" (+${updated.points} pts)` : undefined
    );
    res.json({ ok: true, assignment: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
      reviewerId: req.user!.display_name,
      rejectReason,
    });
    broadcastRealtimeEvent(
      'points_updated',
      action === 'approve'
        ? `⭐ ${updated.display_name} a validé ${updated.item_code} · ${updated.item_name}${updated.points_awarded > 0 ? ` (+${updated.points_awarded} pts)` : ''}`
        : undefined
    );
    res.json({ ok: true, submission: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// Configuration complète d'édition (nouveau + alias legacy /api/admin/settings)
const handleConfigUpdate = (req: AuthedRequest, res: Response) => {
  try {
    const updated = updateEventConfig(db, req.body || {});
    recalculateFeaturedLadder(db);
    recalculateAllFeaturedStages(db);
    recalculateAllRegularityBonuses(db);
    broadcastRealtimeEvent('settings_updated', '⚙️ Configuration de l’édition mise à jour !');
    res.json({ ok: true, eventSettings: updated, eventConfig: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
    recalculateAllFeaturedStages(db);
    broadcastRealtimeEvent('featured_updated', '⭐ Configuration du jeu vedette mise à jour !');
    res.json({ ok: true, featured: updated.featured, eventConfig: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.put('/api/admin/featured/items/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const item = updateFeaturedItem(db, String(req.params.id), req.body || {});
    recalculateAllFeaturedStages(db);
    broadcastRealtimeEvent('featured_updated');
    res.json({ ok: true, item });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.delete('/api/admin/featured/items/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteFeaturedItem(db, String(req.params.id));
    broadcastRealtimeEvent('featured_updated');
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(409).json({ error: errorMessage(err) });
  }
});

// Admin : Tournois (CRUD + Gestion live)
app.post('/api/admin/tournaments', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournament = createTournament(db, req.body || {});
    broadcastRealtimeEvent('tournament_updated', `🏆 Nouveau tournoi ajouté : ${tournament.name}`);
    res.json({ ok: true, tournament });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.put('/api/admin/tournaments/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournament = updateTournament(db, String(req.params.id), req.body || {});
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true, tournament });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.delete('/api/admin/tournaments/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteTournament(db, String(req.params.id));
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(409).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/tournaments/:id/player', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournamentId = String(req.params.id);
    const { userId, pool, checkedIn, teamNumber, teamName } = req.body;
    updateTournamentPlayer(db, tournamentId, { userId: String(userId), pool, checkedIn, teamNumber, teamName });
    broadcastRealtimeEvent('tournament_updated');
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/tournaments/:id/placements', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const placements = Array.isArray(req.body.placements) ? req.body.placements : [];
    recordTournamentPlacements(db, String(req.params.id), placements);
    broadcastRealtimeEvent('points_updated', '🏆 Classement de tournoi mis à jour !');
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/tournaments/:id/rounds', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const tournamentId = String(req.params.id);
    const rawScores = Array.isArray(req.body.scores)
      ? (req.body.scores as { userId?: unknown; scores?: unknown; shows?: unknown }[])
      : [];
    const normalized = rawScores.map((s) => ({
      userId: String(s.userId),
      scores: Array.isArray(s.scores) ? s.scores.map(Number) : Array.isArray(s.shows) ? s.shows.map(Number) : [],
    }));
    const updated = updateTournamentRoundScores(db, tournamentId, normalized);
    broadcastRealtimeEvent('points_updated', '🏆 Scores des manches mis à jour !');
    res.json({ ok: true, standings: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// Alias rétrocompatible Fall Guys
app.post('/api/admin/fall-guys/scores', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const rawScores = Array.isArray(req.body.scores)
      ? (req.body.scores as { userId?: unknown; shows?: unknown }[])
      : [];
    const updated = updateTournamentRoundScores(
      db,
      'fall_guys',
      rawScores.map((s) => ({ userId: String(s.userId), scores: Array.isArray(s.shows) ? s.shows.map(Number) : [] }))
    );
    broadcastRealtimeEvent('points_updated', '🫘 Scores Fall Guys mis à jour en direct !');
    res.json({ ok: true, standings: updated });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
    for (const f of out.orphanProofFiles) unlinkQuietly(path.join(proofsDir, path.basename(f)));
    for (const f of out.orphanReplayFiles) unlinkQuietly(path.join(replaysDir, path.basename(f)));
    broadcastRealtimeEvent('settings_updated', `🚀 Nouvelle édition « ${out.eventConfig.event_name} » créée en mode préparation.`);
    res.json({ ok: true, archived: out.archived, eventConfig: out.eventConfig });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.delete('/api/admin/editions/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteArchivedEdition(db, String(req.params.id));
    broadcastRealtimeEvent('settings_updated');
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(404).json({ error: errorMessage(err) });
  }
});

// Admin : Gestion des rôles Admin depuis l'UI (atomique)
app.post('/api/admin/users/:id/admin', requireAdmin, (req: AuthedRequest, res) => {
  const targetId = String(req.params.id);
  const nextAdmin = req.body?.isAdmin ? 1 : 0;

  try {
    const tx = db.transaction(() => {
      const target = db.prepare(`SELECT id, display_name, is_admin FROM users WHERE id = ?`).get(targetId) as
        | Pick<UserRow, 'id' | 'display_name' | 'is_admin'>
        | undefined;
      if (!target) {
        return { status: 404 as const, error: 'Utilisateur introuvable.' };
      }
      if (nextAdmin === 0 && target.is_admin === 1) {
        const adminsCount = (db.prepare(`SELECT COUNT(*) AS c FROM users WHERE is_admin = 1`).get() as { c: number }).c;
        if (adminsCount <= 1) {
          return { status: 400 as const, error: 'Impossible de retirer les droits du dernier administrateur.' };
        }
      }
      db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`).run(nextAdmin, targetId);
      return { status: 200 as const };
    });
    const out = tx();
    if (out.status !== 200) {
      res.status(out.status).json({ error: out.error });
      return;
    }
    broadcastRealtimeEvent('profile_updated');
    res.json({ ok: true, userId: targetId, is_admin: nextAdmin });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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

function setGameLogo(gameId: string, buf: Buffer): GameRow {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(gameId) as GameRow | undefined;
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
  const safeId = gameId ? `-${safeFilename(gameId, 'game')}` : '';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="hgw-catalog${safeId}-${stamp}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/admin/catalog/import', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const out = importCatalog(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, ...out });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/games', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const game = createGame(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.delete('/api/admin/games/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const result = deleteGame(db, String(req.params.id));
    removeLocalLogo(result.logo_url);
    catalogChanged();
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(409).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/games/:id/logo', requireAdmin, logoUpload.single('logo'), (req: AuthedRequest, res) => {
  try {
    if (!req.file) throw new Error('Aucun fichier reçu.');
    const game = setGameLogo(String(req.params.id), req.file.buffer);
    catalogChanged();
    res.json({ ok: true, game });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

interface SteamGridDbResponse<T> {
  data?: T[];
}

async function steamGridDb<T>(pathname: string): Promise<SteamGridDbResponse<T>> {
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
  return (await r.json()) as SteamGridDbResponse<T>;
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
    const data = await steamGridDb<{ id: number; name: string; release_date?: number; verified?: boolean }>(
      `/search/autocomplete/${encodeURIComponent(q)}`
    );
    const results = (data.data || []).slice(0, 8).map((g) => ({
      id: g.id,
      name: g.name,
      year: g.release_date ? new Date(g.release_date * 1000).getFullYear() : null,
      verified: Boolean(g.verified),
    }));
    res.json({ results });
  } catch (err: unknown) {
    res.status(502).json({ error: errorMessage(err) });
  }
});

app.get('/api/admin/logo-search/:sgdbId/images', requireAdmin, requireLogoSearch, async (req: AuthedRequest, res) => {
  try {
    const sgdbId = Number.parseInt(String(req.params.sgdbId), 10);
    if (!Number.isFinite(sgdbId)) throw new Error('Identifiant invalide.');
    const type = req.query.type === 'logos' ? 'logos' : 'icons';
    const data = await steamGridDb<{ id: number; url: string; thumb: string; width: number; height: number; mime: string }>(
      `/${type}/game/${sgdbId}?nsfw=false&humor=false`
    );
    const images = (data.data || [])
      .filter((i) => ['image/png', 'image/jpeg', 'image/webp'].includes(i.mime))
      .slice(0, 24)
      .map((i) => ({ id: i.id, url: i.url, thumb: i.thumb, width: i.width, height: i.height }));
    res.json({ images });
  } catch (err: unknown) {
    res.status(502).json({ error: errorMessage(err) });
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
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.post('/api/admin/quests', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const quest = createQuest(db, req.body || {});
    catalogChanged();
    res.json({ ok: true, quest });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.put('/api/admin/quests/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const quest = updateQuest(db, String(req.params.id), req.body || {});
    catalogChanged();
    res.json({ ok: true, quest });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

app.delete('/api/admin/quests/:id', requireAdmin, (req: AuthedRequest, res) => {
  try {
    deleteQuest(db, String(req.params.id));
    catalogChanged();
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(409).json({ error: errorMessage(err) });
  }
});

// Sauvegardes & Export JSON
app.get('/api/admin/backup/sqlite', requireAdmin, async (_req: AuthedRequest, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpBackupPath = path.join(replaysDir, `hgw-backup-${stamp}.sqlite`);
  try {
    await db.backup(tmpBackupPath);
    const fileBuf = fs.readFileSync(tmpBackupPath);
    unlinkQuietly(tmpBackupPath);
    res.setHeader('Content-Type', 'application/x-sqlite3');
    res.setHeader('Content-Disposition', `attachment; filename="hgw-backup-${stamp.slice(0, 10)}.sqlite"`);
    res.send(fileBuf);
  } catch (err: unknown) {
    unlinkQuietly(tmpBackupPath);
    res.status(500).json({ error: errorMessage(err, 'Erreur lors de la sauvegarde SQLite.') });
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
    } catch (err: unknown) {
      console.warn(`ℹ️ [seed-demo] Quêtes ignorées pour ${p.name}:`, errorMessage(err));
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
      } catch (err: unknown) {
        console.warn(`ℹ️ [seed-demo] Replays ignorés pour ${p.name}:`, errorMessage(err));
      }
    }
  }

  const teamTourney = activeTournaments.find((t) => t.team_size > 1);
  if (teamTourney) {
    try {
      generateBalancedTeams(db, teamTourney.id, true);
    } catch (err: unknown) {
      console.warn('ℹ️ [seed-demo] Tirage d’équipes ignoré:', errorMessage(err));
    }
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
