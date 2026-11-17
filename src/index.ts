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
import { initDb } from './db.js';
import {
  drawDailyQuestsForUser,
  generateBalancedTeams,
  getGlobalLeaderboard,
  getParisDayAndWeekKey,
  recalculateWeeklyTmnfLeaderboard,
  recordTournamentPlacements,
  rerollDailyAssignment,
  reviewDailyAssignment,
  runNightlyDailyReset,
  saveUserSelectedGames,
  submitDailyProof,
  submitTmnfReplay,
  TOMBOLA_POINTS_THRESHOLD,
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

const { db, proofsDir, replaysDir } = initDb();
const bot = new HgwDiscordBot(db, proofsDir);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Fichiers statiques et preuves
const publicDir = path.resolve(__dirname, '../public');
app.use('/uploads/proofs', express.static(proofsDir));
app.use(express.static(publicDir));

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

// Connexion rapide en mode Démo / Dev (quand DISCORD_CLIENT_ID n'est pas configuré ou ALLOW_DEV_LOGIN=true)
app.post('/api/auth/dev-login', (req, res) => {
  const allowDev =
    process.env.ALLOW_DEV_LOGIN === 'true' || !process.env.DISCORD_CLIENT_ID?.trim();
  if (!allowDev) {
    res.status(403).json({ error: 'Le mode Dev Login est désactivé en production.' });
    return;
  }

  const rawName = String(req.body.username || 'Hextaz').trim().slice(0, 32) || 'Hextaz';
  const asAdmin = req.body.isAdmin !== undefined ? Boolean(req.body.isAdmin) : true;
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
  const games = db.prepare(`SELECT * FROM games ORDER BY sort_order ASC`).all();
  const leaderboard = getGlobalLeaderboard(db);
  const weeklyTmnf = recalculateWeeklyTmnfLeaderboard(db);

  const tmnfMaps = db.prepare(`SELECT * FROM tmnf_maps ORDER BY sort_order ASC`).all() as any[];
  const formattedMaps = tmnfMaps.map((m) => ({
    ...m,
    author_formatted: formatTmTime(m.author_ms),
    gold_formatted: formatTmTime(m.gold_ms),
    silver_formatted: formatTmTime(m.silver_ms),
    bronze_formatted: formatTmTime(m.bronze_ms),
  }));

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

  let pendingProofs: any[] = [];
  let allUsers: any[] = [];
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
  }

  res.json({
    serverTime: new Date().toISOString(),
    dayKey,
    weekKey,
    oauthConfigured: Boolean(process.env.DISCORD_CLIENT_ID?.trim()),
    allowDevLogin: process.env.ALLOW_DEV_LOGIN === 'true' || !process.env.DISCORD_CLIENT_ID?.trim(),
    botStatus: bot.getStatus(),
    tmnfServer: {
      login: process.env.TMNF_SERVER_LOGIN || 'hgw_stadium_2026',
      playitAddress: process.env.TMNF_PLAYIT_ADDRESS || 'hgw-tmnf.playit.gg:2350',
      joinUrl: process.env.TMNF_JOIN_URL || 'tmtp://#join=hgw_stadium_2026',
    },
    tombolaThreshold: TOMBOLA_POINTS_THRESHOLD,
    user: req.user || null,
    mySelectedGames,
    myDailyQuests,
    canRerollToday,
    myTmnfSubmissions,
    myLedger,
    games,
    tmnfMaps: formattedMaps,
    weeklyTmnfLeaderboard: weeklyTmnf,
    tournaments: tournamentsWithRegs,
    leaderboard,
    admin: req.user?.is_admin === 1 ? { pendingProofs, allUsers } : null,
  });
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

// Soumission d'une preuve (upload fichier ou lien)
app.post('/api/quests/:id/submit', requireAuth, proofUpload.single('proofFile'), async (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const proofUrl = typeof req.body.proofUrl === 'string' ? req.body.proofUrl.trim() : '';
    const proofNote = typeof req.body.proofNote === 'string' ? req.body.proofNote.trim() : '';
    const proofFile = req.file?.filename;

    const updated = submitDailyProof(db, {
      userId: req.user.id,
      assignmentId,
      proofUrl: proofUrl || undefined,
      proofFile,
      proofNote: proofNote || undefined,
    });

    await bot.notifyProofSubmitted(updated);
    res.json({ ok: true, assignment: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Échec de l’envoi de la preuve.' });
  }
});

// ============================================================================
// TRACKMANIA (.Replay.gbx) UPLOAD & GÉNÉRATEUR DE REPLAY DE TEST
// ============================================================================

app.post('/api/tmnf/submit-replay', requireAuth, gbxUpload.single('replay'), (req: AuthedRequest, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      res.status(400).json({ error: 'Veuillez sélectionner un fichier .Replay.gbx.' });
      return;
    }

    const explicitMapId = typeof req.body.mapId === 'string' ? req.body.mapId : undefined;
    const result = submitTmnfReplay(db, {
      userId: req.user.id,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      explicitMapId,
    });

    // Sauvegarder une copie d'archive dans /data/replays
    const safeReplayName = `${Date.now()}_${req.user.id}_${result.map.code}.Replay.gbx`;
    fs.writeFileSync(path.join(replaysDir, safeReplayName), req.file.buffer);

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
});

// Permet de télécharger un fichier .Replay.gbx d'exemple valide pour tester l'upload en 1 clic
app.get('/api/tmnf/sample-replay/:mapId', requireAuth, (req: AuthedRequest, res) => {
  const map = db.prepare(`SELECT * FROM tmnf_maps WHERE id = ?`).get(String(req.params.mapId)) as any;
  if (!map) {
    res.status(404).json({ error: 'Map introuvable.' });
    return;
  }

  // Génère un temps médaille Auteur légèrement meilleur que le seuil Auteur
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
    res.json({ ok: true, registered: false });
  } else {
    db.prepare(
      `INSERT INTO tournament_registrations (tournament_id, user_id, pool, checked_in) VALUES (?, ?, 2, 0)`
    ).run(tournamentId, req.user.id);
    res.json({ ok: true, registered: true });
  }
});

// ============================================================================
// BACK-OFFICE ADMIN (VALIDATION PREUVES, CHAPEAUX, TIRAGE LIVE, SIMULATION)
// ============================================================================

app.post('/api/admin/proofs/:id/review', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const assignmentId = Number.parseInt(String(req.params.id), 10);
    const action = req.body.action === 'reject' ? 'reject' : 'approve';
    const rejectReason = typeof req.body.rejectReason === 'string' ? req.body.rejectReason.trim() : undefined;

    const updated = reviewDailyAssignment(db, {
      assignmentId,
      action,
      reviewerId: req.user.display_name,
      rejectReason,
    });
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
  res.json({ ok: true });
});

app.post('/api/admin/tournaments/:id/draw-teams', requireAdmin, async (req: AuthedRequest, res) => {
  try {
    const onlyCheckedIn = req.body.onlyCheckedIn !== undefined ? Boolean(req.body.onlyCheckedIn) : true;
    const result = generateBalancedTeams(db, String(req.params.id), onlyCheckedIn);
    if (req.body.announceDiscord) {
      await bot.announceTeams(result.tournament, result.teams);
    }
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/tournaments/:id/placements', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const placements = Array.isArray(req.body.placements) ? req.body.placements : [];
    recordTournamentPlacements(db, String(req.params.id), placements);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/fall-guys/scores', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const scores = Array.isArray(req.body.scores) ? req.body.scores : [];
    const updated = updateFallGuysScoresAndRankings(db, scores);
    res.json({ ok: true, standings: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/cron/trigger', requireAdmin, (_req: AuthedRequest, res) => {
  const result = runNightlyDailyReset(db);
  res.json({ ok: true, ...result });
});

// Seeder de démonstration en 1 clic pour peupler 12 joueurs, des médailles TMNF, des équipes RL Chapeaux et des preuves
app.post('/api/admin/seed-demo', requireAdmin, (_req: AuthedRequest, res) => {
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

    // Soumettre un replay sur la map hebdo et A01-Race si pas encore fait
    const existingSub = db
      .prepare(`SELECT COUNT(*) AS cnt FROM tmnf_submissions WHERE user_id = ?`)
      .get(p.id) as { cnt: number };

    if (existingSub.cnt === 0 && weeklyMap && medal1) {
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

      const bufMedal = buildSampleReplayGbx({
        mapUid: medal1.uid,
        bestTimeMs: medal1.author_ms + (p.pool - 1) * 900,
        playerLogin: p.name.toLowerCase(),
        playerNickname: p.name,
        nonce: `medal1_${p.id}`,
      });
      submitTmnfReplay(db, {
        userId: p.id,
        buffer: bufMedal,
        fileName: `${p.name}_A01.Replay.gbx`,
      });
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
