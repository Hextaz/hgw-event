import type Database from 'better-sqlite3';
import {
  getCurrentActDayBounds,
  getEventConfig,
  isPlayablePhase,
  normalizeProofUrl,
  updateEventConfig,
  type EventConfig,
  type EventConfigPatch,
} from './config.js';
import {
  getFeaturedItemLeaderboard,
  recalculateFeaturedLadder,
  recordTmnfLiveServerFinish,
  submitTmnfReplay,
} from './featured.js';
import {
  generateBalancedTeams,
  recordTournamentPlacements,
  updateTournamentRoundScores,
} from './tournaments.js';
import type {
  DailyAssignmentDetailRow,
  Difficulty,
  FeaturedLadderEntry,
  LeaderboardEntry,
  QuestRow,
  RegularitySummary,
  TournamentRegistrationDetailRow,
  UserRow,
} from './types.js';

// Constantes par défaut conservées pour compatibilité ascendante (les règles effectives viennent de `getEventConfig(db)`)
export const MIN_SELECTED_GAMES = 4;
export const MAX_WEEKLY_QUESTS_PER_GAME = 4;
export const DAILY_QUESTS_COUNT = 3;
export const TOMBOLA_POINTS_THRESHOLD = 300;

export const REGULARITY_TIERS = [
  { days: 4, points: 20, ref: 'regularity:tier_4', label: '🔥 Palier Régularité — 4 Jours Actifs (+20 pts)' },
  { days: 8, points: 40, ref: 'regularity:tier_8', label: '🔥 Palier Régularité — 8 Jours Actifs (+40 pts)' },
  { days: 12, points: 60, ref: 'regularity:tier_12', label: '👑 Palier Régularité — 12 Jours Actifs (+60 pts)' },
] as const;

export const MEDAL_POINTS: Record<string, number> = {
  author: 30,
  gold: 20,
  silver: 10,
  bronze: 5,
  none: 0,
};

export const WEEKLY_TMNF_TOP10_POINTS = [150, 110, 80, 50, 50, 50, 30, 30, 30, 30];

export type EventLifecycleSettings = EventConfig;

// Ré-exports de compatibilité ascendante pour les routes et tests existants
export {
  generateBalancedTeams,
  recordTournamentPlacements,
  recordTmnfLiveServerFinish,
  submitTmnfReplay,
};

export function recalculateWeeklyTmnfLeaderboard(db: Database.Database): FeaturedLadderEntry[] {
  return recalculateFeaturedLadder(db);
}

export function getMapLeaderboard(db: Database.Database, mapId: string) {
  return getFeaturedItemLeaderboard(db, mapId);
}

export function updateFallGuysScoresAndRankings(
  db: Database.Database,
  scores: { userId: string; shows: number[] }[]
): TournamentRegistrationDetailRow[] {
  return updateTournamentRoundScores(
    db,
    'fall_guys',
    scores.map((s) => ({ userId: s.userId, scores: s.shows }))
  );
}

export function getEventSettings(db: Database.Database, now: Date = new Date()): EventConfig {
  return getEventConfig(db, now);
}

export function updateEventSettings(db: Database.Database, updates: EventConfigPatch): EventConfig {
  return updateEventConfig(db, updates);
}

/**
 * Calcule la clé du jour (`YYYY-MM-DD`) et de la semaine (`YYYY-Www`) avec bascule à 03h00 Europe/Paris.
 */
export function getParisDayAndWeekKey(now: Date = new Date()): { dayKey: string; weekKey: string } {
  const shifted = new Date(now.getTime() - 3 * 3600 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayKey = formatter.format(shifted);

  const [y, m, d] = dayKey.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const weekKey = `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

  return { dayKey, weekKey };
}

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Met à jour le login Trackmania d'un joueur en préservant l'unicité inter-joueurs
 * et en verrouillant la modification après le premier replay GBX validé (sauf admin).
 */
export function updateUserTmnfLogin(
  db: Database.Database,
  userId: string,
  rawLogin: string | null | undefined,
  opts: { isAdmin?: boolean } = {}
): string | null {
  const user = db.prepare(`SELECT id, tmnf_login FROM users WHERE id = ?`).get(userId) as
    | Pick<UserRow, 'id' | 'tmnf_login'>
    | undefined;
  if (!user) throw new Error('Utilisateur introuvable.');

  const cleaned = String(rawLogin || '').trim().slice(0, 40) || null;
  if (cleaned && cleaned.toLowerCase() === 'unknown_driver') {
    throw new Error('Login Trackmania invalide.');
  }

  const unchanged = (user.tmnf_login || '').toLowerCase() === (cleaned || '').toLowerCase();
  if (unchanged) return user.tmnf_login || null;

  if (!opts.isAdmin && user.tmnf_login) {
    const hasGbx = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM featured_submissions WHERE user_id = ? AND proof_type = 'gbx' AND status = 'validated'`)
        .get(userId) as { c: number }
    ).c;
    if (hasGbx > 0) {
      throw new Error(
        `Votre login Trackmania ("${user.tmnf_login}") est verrouillé après votre premier replay validé. Contactez un organisateur pour le modifier.`
      );
    }
  }

  if (cleaned) {
    const owner = db
      .prepare(`SELECT id, display_name FROM users WHERE LOWER(tmnf_login) = LOWER(?) AND id != ?`)
      .get(cleaned, userId) as { id: string; display_name: string } | undefined;
    if (owner) {
      throw new Error(`Le login Trackmania "${cleaned}" est déjà lié au joueur "${owner.display_name}".`);
    }
  }

  db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(cleaned, userId);
  return cleaned;
}

/**
 * Calcule le nombre de défis soumis/validés par jeu sur l'acte en cours (ou la semaine ISO si pas de bornes d'acte).
 */
export function getUserActGameCounts(
  db: Database.Database,
  userId: string,
  now: Date = new Date(),
  excludeAssignmentId?: number
): Map<string, number> {
  const cfg = getEventConfig(db, now);
  const { weekKey } = getParisDayAndWeekKey(now);
  const { startDayKey, endDayKey } = getCurrentActDayBounds(cfg);

  let rows: { game_id: string; cnt: number }[];
  if (startDayKey) {
    const excludeSql = excludeAssignmentId !== undefined ? ` AND da.id != ?` : '';
    const params: (string | number)[] = [userId, startDayKey];
    let endSql = '';
    if (endDayKey) {
      endSql = ` AND da.day_key < ?`;
      params.push(endDayKey);
    }
    if (excludeAssignmentId !== undefined) params.push(excludeAssignmentId);

    rows = db
      .prepare(
        `SELECT q.game_id, COUNT(*) AS cnt
         FROM daily_assignments da
         JOIN quests q ON q.id = da.quest_id
         WHERE da.user_id = ? AND da.day_key >= ?${endSql} AND da.status IN ('validated', 'submitted')${excludeSql}
         GROUP BY q.game_id`
      )
      .all(...params) as { game_id: string; cnt: number }[];
  } else {
    const excludeSql = excludeAssignmentId !== undefined ? ` AND da.id != ?` : '';
    const params: (string | number)[] = [userId, weekKey];
    if (excludeAssignmentId !== undefined) params.push(excludeAssignmentId);
    rows = db
      .prepare(
        `SELECT q.game_id, COUNT(*) AS cnt
         FROM daily_assignments da
         JOIN quests q ON q.id = da.quest_id
         WHERE da.user_id = ? AND da.week_key = ? AND da.status IN ('validated', 'submitted')${excludeSql}
         GROUP BY q.game_id`
      )
      .all(...params) as { game_id: string; cnt: number }[];
  }

  const map = new Map<string, number>();
  for (const r of rows) map.set(r.game_id, r.cnt);
  return map;
}

/**
 * Sauvegarde les jeux cochés par un joueur (min configuré hors Fil Rouge) et tire ses premiers défis du jour si l'édition est active.
 */
export function saveUserSelectedGames(
  db: Database.Database,
  userId: string,
  gameIds: string[],
  now: Date = new Date()
): { selectedGames: string[]; assignmentsCreated: number } {
  const cfg = getEventConfig(db, now);
  if (cfg.effective_phase === 'draft' || cfg.effective_phase === 'closed') {
    throw new Error('L’édition est en préparation ou clôturée : impossible de modifier vos jeux.');
  }
  const minGames = cfg.min_selected_games;

  const validNonUniversal = db
    .prepare(
      `SELECT id FROM games g WHERE is_universal = 0 AND active = 1
         AND EXISTS (SELECT 1 FROM quests q WHERE q.game_id = g.id AND q.active = 1)`
    )
    .all() as { id: string }[];
  const validSet = new Set(validNonUniversal.map((g) => g.id));

  const cleaned = Array.from(new Set(gameIds.filter((id) => validSet.has(id))));
  if (cleaned.length < minGames) {
    throw new Error(`Vous devez sélectionner au moins ${minGames} jeux (hors Fil Rouge Web Gratuit).`);
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_games WHERE user_id = ?`).run(userId);
    const insertUg = db.prepare(`INSERT INTO user_games (user_id, game_id) VALUES (?, ?)`);
    for (const gid of cleaned) {
      insertUg.run(userId, gid);
    }
  });
  tx();

  let assignmentsCreated = 0;
  if (isPlayablePhase(cfg.effective_phase)) {
    const { dayKey } = getParisDayAndWeekKey(now);
    const existingToday = db
      .prepare(`SELECT COUNT(*) AS cnt FROM daily_assignments WHERE user_id = ? AND day_key = ? AND status != 'rerolled'`)
      .get(userId, dayKey) as { cnt: number };

    if (existingToday.cnt === 0) {
      const drawn = drawDailyQuestsForUser(db, userId, now);
      assignmentsCreated = drawn.length;
    }
  }

  return { selectedGames: cleaned, assignmentsCreated };
}

/**
 * Algorithme de tirage quotidien stratifié piloté par la config de l'édition.
 */
export function drawDailyQuestsForUser(
  db: Database.Database,
  userId: string,
  now: Date = new Date()
): DailyAssignmentDetailRow[] {
  const { dayKey, weekKey } = getParisDayAndWeekKey(now);
  const cfg = getEventConfig(db, now);
  if (!isPlayablePhase(cfg.effective_phase)) {
    return [];
  }

  const currentAct = cfg.current_act;
  const dailyCount = cfg.daily_quests_count;
  const minGames = cfg.min_selected_games;
  const maxPerGame = cfg.max_quests_per_game_per_act;

  const currentActive = db
    .prepare(
      `SELECT da.*, q.title, q.description, q.difficulty, q.points, q.game_id, q.proof_hint, q.unlock_week, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.user_id = ? AND da.day_key = ? AND da.status != 'rerolled'
       ORDER BY da.id ASC`
    )
    .all(userId, dayKey) as DailyAssignmentDetailRow[];

  if (currentActive.length >= dailyCount) {
    return currentActive;
  }

  const userGameRows = db.prepare(`SELECT game_id FROM user_games WHERE user_id = ?`).all(userId) as { game_id: string }[];
  if (userGameRows.length < minGames) {
    return [];
  }

  const candidateGameIds = new Set<string>(userGameRows.map((r) => r.game_id));
  const universalGames = db.prepare(`SELECT id FROM games WHERE is_universal = 1 AND active = 1`).all() as { id: string }[];
  for (const ug of universalGames) candidateGameIds.add(ug.id);

  const actGameCount = getUserActGameCounts(db, userId, now);

  let eligibleGames = Array.from(candidateGameIds).filter((gid) => (actGameCount.get(gid) || 0) < maxPerGame);
  if (eligibleGames.length === 0) {
    eligibleGames = Array.from(candidateGameIds);
  }

  const weekAssignedRows = db
    .prepare(`SELECT quest_id, status, day_key FROM daily_assignments WHERE user_id = ? AND week_key = ?`)
    .all(userId, weekKey) as { quest_id: string; status: string; day_key: string }[];

  const neverDrawnExclusion = new Set(weekAssignedRows.map((r) => r.quest_id));
  const hardExclusion = new Set(
    weekAssignedRows
      .filter((r) => r.status === 'validated' || r.status === 'submitted' || r.day_key === dayKey)
      .map((r) => r.quest_id)
  );

  const placeholders = eligibleGames.map(() => '?').join(',');
  const allEligibleQuests = db
    .prepare(
      `SELECT id, game_id, title, description, difficulty, points, COALESCE(unlock_week, 1) AS unlock_week
       FROM quests
       WHERE active = 1 AND game_id IN (SELECT id FROM games WHERE active = 1) AND COALESCE(unlock_week, 1) <= ? AND game_id IN (${placeholders})`
    )
    .all(currentAct, ...eligibleGames) as {
    id: string;
    game_id: string;
    title: string;
    description: string;
    difficulty: Difficulty;
    points: number;
    unlock_week: number;
  }[];

  const freshPool = shuffle(allEligibleQuests.filter((q) => !neverDrawnExclusion.has(q.id)));
  const fallbackPool = shuffle(allEligibleQuests.filter((q) => !hardExclusion.has(q.id)));

  const needed = dailyCount - currentActive.length;
  const pattern: Difficulty[] = ['easy', 'medium', 'hard'];
  const targetDifficulties: Difficulty[] = Array.from(
    { length: needed },
    (_, i) => pattern[i % pattern.length]
  );

  const chosen: typeof allEligibleQuests = [];
  const chosenIds = new Set<string>(currentActive.map((a) => a.quest_id));
  const gameCountToday = new Map<string, number>();
  for (const a of currentActive) {
    gameCountToday.set(a.game_id, (gameCountToday.get(a.game_id) || 0) + 1);
  }

  const pickOne = (pool: typeof allEligibleQuests, diff: Difficulty | null, maxSame: number) => {
    for (const q of pool) {
      if (chosenIds.has(q.id)) continue;
      if (diff && q.difficulty !== diff) continue;
      if ((gameCountToday.get(q.game_id) || 0) >= maxSame) continue;
      return q;
    }
    return null;
  };

  for (const targetDiff of targetDifficulties) {
    const picked =
      pickOne(freshPool, targetDiff, 1) ||
      pickOne(freshPool, targetDiff, 2) ||
      pickOne(fallbackPool, targetDiff, 1) ||
      pickOne(fallbackPool, targetDiff, 2) ||
      pickOne(freshPool, null, 1) ||
      pickOne(freshPool, null, 2) ||
      pickOne(fallbackPool, null, 3);

    if (picked) {
      chosen.push(picked);
      chosenIds.add(picked.id);
      gameCountToday.set(picked.game_id, (gameCountToday.get(picked.game_id) || 0) + 1);
    }
  }

  const insertStmt = db.prepare(`
    INSERT INTO daily_assignments (user_id, quest_id, day_key, week_key, status)
    VALUES (?, ?, ?, ?, 'open')
  `);

  const tx = db.transaction(() => {
    for (const q of chosen) {
      insertStmt.run(userId, q.id, dayKey, weekKey);
    }
  });
  tx();

  return db
    .prepare(
      `SELECT da.*, q.title, q.description, q.difficulty, q.points, q.game_id, q.proof_hint, q.unlock_week, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.user_id = ? AND da.day_key = ? AND da.status != 'rerolled'
       ORDER BY CASE q.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC`
    )
    .all(userId, dayKey) as DailyAssignmentDetailRow[];
}

/**
 * Reset quotidien de 03h00 : expire les défis ouverts de la veille et tire ceux du jour.
 */
export function runNightlyDailyReset(
  db: Database.Database,
  now: Date = new Date()
): { expiredCount: number; usersProcessed: number; questsAssigned: number } {
  const { dayKey } = getParisDayAndWeekKey(now);
  const cfg = getEventConfig(db, now);

  const expireRes = db
    .prepare(`UPDATE daily_assignments SET status = 'expired' WHERE day_key < ? AND status = 'open'`)
    .run(dayKey);

  if (!isPlayablePhase(cfg.effective_phase)) {
    return { expiredCount: expireRes.changes, usersProcessed: 0, questsAssigned: 0 };
  }

  const eligibleUsers = db
    .prepare(
      `SELECT user_id
       FROM user_games
       GROUP BY user_id
       HAVING COUNT(game_id) >= ?`
    )
    .all(cfg.min_selected_games) as { user_id: string }[];

  let questsAssigned = 0;
  for (const u of eligibleUsers) {
    const drawn = drawDailyQuestsForUser(db, u.user_id, now);
    questsAssigned += drawn.length;
  }

  return {
    expiredCount: expireRes.changes,
    usersProcessed: eligibleUsers.length,
    questsAssigned,
  };
}

/**
 * Relance (Reroll) d'un défi ouvert (quota journalier configurable).
 */
export function rerollDailyAssignment(
  db: Database.Database,
  userId: string,
  assignmentId: number,
  now: Date = new Date()
): DailyAssignmentDetailRow[] {
  const { dayKey, weekKey } = getParisDayAndWeekKey(now);
  const cfg = getEventConfig(db, now);
  if (!isPlayablePhase(cfg.effective_phase)) {
    throw new Error('Les relances sont fermées hors période active.');
  }
  const maxRerolls = cfg.daily_rerolls_max;

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as UserRow | undefined;
  if (!user) throw new Error('Utilisateur introuvable.');

  if (maxRerolls <= 0) {
    throw new Error('Le reroll de défi est désactivé sur cette édition.');
  }

  const usedToday = user.reroll_day_key === dayKey ? Number(user.rerolls_used || 0) : 0;
  if (usedToday >= maxRerolls) {
    throw new Error(`Vous avez déjà utilisé votre Reroll gratuit aujourd’hui (${maxRerolls} reroll max / jour).`);
  }

  const assignment = db
    .prepare(
      `SELECT da.*, q.difficulty, q.game_id
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       WHERE da.id = ? AND da.user_id = ?`
    )
    .get(assignmentId, userId) as (DailyAssignmentDetailRow & { difficulty: Difficulty; game_id: string }) | undefined;

  if (!assignment) throw new Error('Défi introuvable.');
  if (assignment.day_key !== dayKey) throw new Error('Seuls les défis du jour en cours peuvent être relancés.');
  if (assignment.status !== 'open') throw new Error('Seul un défi non soumis (ouvert) peut être relancé.');

  const userGameRows = db.prepare(`SELECT game_id FROM user_games WHERE user_id = ?`).all(userId) as { game_id: string }[];
  const universalGames = db.prepare(`SELECT id FROM games WHERE is_universal = 1 AND active = 1`).all() as { id: string }[];
  const gameIds = Array.from(new Set([...universalGames.map((g) => g.id), ...userGameRows.map((r) => r.game_id)]));
  const placeholders = gameIds.map(() => '?').join(',');

  const alreadyToday = db
    .prepare(`SELECT quest_id FROM daily_assignments WHERE user_id = ? AND day_key = ?`)
    .all(userId, dayKey) as { quest_id: string }[];
  const excludeIds = new Set(alreadyToday.map((r) => r.quest_id));
  excludeIds.add(assignment.quest_id);

  const candidates = db
    .prepare(
      `SELECT * FROM quests
       WHERE active = 1 AND game_id IN (SELECT id FROM games WHERE active = 1) AND difficulty = ? AND COALESCE(unlock_week, 1) <= ? AND game_id IN (${placeholders})`
    )
    .all(assignment.difficulty, cfg.current_act, ...gameIds) as QuestRow[];

  const available = shuffle(candidates.filter((c) => !excludeIds.has(c.id)));
  if (available.length === 0) {
    throw new Error('Aucune autre quête de même difficulté disponible pour un reroll.');
  }

  const replacement = available[0];

  const tx = db.transaction(() => {
    const upd = db
      .prepare(`UPDATE daily_assignments SET status = 'rerolled' WHERE id = ? AND status = 'open'`)
      .run(assignmentId);
    if (upd.changes === 0) throw new Error('Ce défi ne peut plus être relancé.');
    db.prepare(
      `INSERT INTO daily_assignments (user_id, quest_id, day_key, week_key, status)
       VALUES (?, ?, ?, ?, 'open')`
    ).run(userId, replacement.id, dayKey, weekKey);
    db.prepare(`UPDATE users SET reroll_day_key = ?, rerolls_used = ? WHERE id = ?`).run(dayKey, usedToday + 1, userId);
  });
  tx();

  return drawDailyQuestsForUser(db, userId, now);
}

/**
 * Lecture pure (CQS) de la progression régularité d'un joueur : aucune écriture SQLite.
 */
export function getUserRegularitySummary(db: Database.Database, userId: string): RegularitySummary {
  const cfg = getEventConfig(db);
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT day_key) AS active_days
       FROM daily_assignments
       WHERE user_id = ? AND status = 'validated'`
    )
    .get(userId) as { active_days: number } | undefined;

  const activeDaysCount = row?.active_days || 0;
  let totalBonusPoints = 0;
  const tiers = cfg.regularity_tiers.map((t) => {
    const unlocked = activeDaysCount >= t.days;
    if (unlocked) totalBonusPoints += t.points;
    return { days: t.days, points: t.points, unlocked };
  });

  return { activeDaysCount, totalBonusPoints, tiers };
}

function syncUserRegularityInternal(db: Database.Database, userId: string): RegularitySummary {
  const cfg = getEventConfig(db);
  const summary = getUserRegularitySummary(db, userId);

  db.prepare(`DELETE FROM points_ledger WHERE user_id = ? AND source_ref LIKE ?`).run(userId, `regularity:%:${userId}`);

  for (const tier of cfg.regularity_tiers) {
    const sourceRef = `regularity:tier_${tier.days}:${userId}`;
    if (summary.activeDaysCount >= tier.days) {
      const label = `${tier.label || `Palier Régularité — ${tier.days} Jours Actifs`} (+${tier.points} pts)`;
      db.prepare(
        `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label, updated_at)
         VALUES (?, 'daily', ?, 'async', ?, ?, datetime('now'))
         ON CONFLICT(source_ref) DO UPDATE SET
           points = excluded.points,
           label = excluded.label,
           updated_at = datetime('now')`
      ).run(userId, sourceRef, tier.points, label);
    }
  }

  return summary;
}

/**
 * Calcule les jours actifs et synchronise les paliers de régularité configurés dans `points_ledger`.
 */
export function recalculateUserRegularityBonuses(db: Database.Database, userId: string): RegularitySummary {
  const tx = db.transaction(() => syncUserRegularityInternal(db, userId));
  return tx();
}

export function recalculateAllRegularityBonuses(db: Database.Database): void {
  const tx = db.transaction(() => {
    const users = db.prepare(`SELECT id FROM users`).all() as { id: string }[];
    for (const u of users) {
      syncUserRegularityInternal(db, u.id);
    }
  });
  tx();
}

/**
 * Soumission d'une preuve pour un défi quotidien.
 */
export function submitDailyProof(
  db: Database.Database,
  params: {
    userId: string;
    assignmentId: number;
    proofUrl?: string;
    proofFile?: string;
    proofNote?: string;
  },
  now: Date = new Date()
): DailyAssignmentDetailRow {
  const cfg = getEventConfig(db, now);
  if (!isPlayablePhase(cfg.effective_phase)) {
    throw new Error('Les soumissions de défis sont fermées pour le moment.');
  }

  const assignment = db
    .prepare(
      `SELECT da.*, q.title, q.description, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.id = ? AND da.user_id = ?`
    )
    .get(params.assignmentId, params.userId) as DailyAssignmentDetailRow | undefined;

  if (!assignment) throw new Error('Défi introuvable pour cet utilisateur.');
  if (assignment.status !== 'open' && assignment.status !== 'rejected') {
    throw new Error(`Ce défi ne peut plus être soumis (statut actuel : ${assignment.status}).`);
  }

  const safeProofUrl = normalizeProofUrl(params.proofUrl);
  if (!params.proofFile && !safeProofUrl) {
    throw new Error('Veuillez fournir un fichier (screenshot/clip) ou un lien vidéo externe.');
  }

  const actCounts = getUserActGameCounts(db, params.userId, now, params.assignmentId);
  if ((actCounts.get(assignment.game_id) || 0) >= cfg.max_quests_per_game_per_act) {
    throw new Error(
      `Vous avez déjà atteint la limite de ${cfg.max_quests_per_game_per_act} défis validés/soumis sur ce jeu sur cet acte.`
    );
  }

  const proofType = params.proofFile ? 'file' : 'link';
  db.prepare(
    `UPDATE daily_assignments
     SET status = 'submitted',
         proof_type = ?,
         proof_url = ?,
         proof_file = ?,
         proof_note = ?,
         reject_reason = NULL,
         submitted_at = datetime('now')
     WHERE id = ? AND status IN ('open', 'rejected')`
  ).run(
    proofType,
    safeProofUrl || null,
    params.proofFile || null,
    params.proofNote ? params.proofNote.trim().slice(0, 200) : null,
    params.assignmentId
  );

  return db
    .prepare(
      `SELECT da.*, q.title, q.description, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji, u.display_name, u.username
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       JOIN users u ON u.id = da.user_id
       WHERE da.id = ?`
    )
    .get(params.assignmentId) as DailyAssignmentDetailRow;
}

/**
 * Validation ou refus atomique d'une preuve de défi quotidien (protège contre la double validation Web + Discord).
 */
export function reviewDailyAssignment(
  db: Database.Database,
  params: {
    assignmentId: number;
    action: 'approve' | 'reject';
    reviewerId: string;
    rejectReason?: string;
    allowOverride?: boolean;
  }
): DailyAssignmentDetailRow {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT da.*, q.title, q.description, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji, u.display_name
         FROM daily_assignments da
         JOIN quests q ON q.id = da.quest_id
         JOIN games g ON g.id = q.game_id
         JOIN users u ON u.id = da.user_id
         WHERE da.id = ?`
      )
      .get(params.assignmentId) as DailyAssignmentDetailRow | undefined;

    if (!row) throw new Error(`Défi #${params.assignmentId} introuvable.`);

    const statusGuard = params.allowOverride ? '' : ` AND status = 'submitted'`;
    const sourceRef = `daily:${row.id}`;

    if (params.action === 'approve') {
      const res = db
        .prepare(
          `UPDATE daily_assignments
           SET status = 'validated', reviewer_id = ?, reject_reason = NULL, reviewed_at = datetime('now')
           WHERE id = ?${statusGuard}`
        )
        .run(params.reviewerId, row.id);
      if (res.changes === 0) {
        throw new Error(`La preuve #${row.id} a déjà été traitée (statut : ${row.status}).`);
      }

      db.prepare(
        `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label, updated_at)
         VALUES (?, 'daily', ?, 'async', ?, ?, datetime('now'))
         ON CONFLICT(source_ref) DO UPDATE SET
           points = excluded.points,
           label = excluded.label,
           updated_at = datetime('now')`
      ).run(
        row.user_id,
        sourceRef,
        row.points,
        `${row.game_emoji} Défi ${row.game_name} — ${row.title} (+${row.points} pts)`
      );
    } else {
      const res = db
        .prepare(
          `UPDATE daily_assignments
           SET status = 'rejected', reviewer_id = ?, reject_reason = ?, reviewed_at = datetime('now')
           WHERE id = ?${statusGuard}`
        )
        .run(params.reviewerId, params.rejectReason || 'Preuve incomplète ou non conforme.', row.id);
      if (res.changes === 0) {
        throw new Error(`La preuve #${row.id} a déjà été traitée (statut : ${row.status}).`);
      }

      db.prepare(`DELETE FROM points_ledger WHERE source_ref = ?`).run(sourceRef);
    }

    syncUserRegularityInternal(db, row.user_id);
  });

  tx();

  return db
    .prepare(
      `SELECT da.*, q.title, q.description, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji, u.display_name
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       JOIN users u ON u.id = da.user_id
       WHERE da.id = ?`
    )
    .get(params.assignmentId) as DailyAssignmentDetailRow;
}

/**
 * Classement général dynamique (seuil tombola & compteur jeu vedette configurables).
 */
export function getGlobalLeaderboard(db: Database.Database): LeaderboardEntry[] {
  const cfg = getEventConfig(db);
  const threshold = cfg.tombola_threshold;

  const rows = db
    .prepare(
      `SELECT
         u.id,
         u.username,
         u.display_name,
         u.avatar,
         u.tmnf_login,
         COALESCE(SUM(CASE WHEN pl.category = 'async' THEN pl.points ELSE 0 END), 0) AS async_points,
         COALESCE(SUM(CASE WHEN pl.category = 'live' THEN pl.points ELSE 0 END), 0) AS live_points,
         COALESCE(SUM(pl.points), 0) AS total_points,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.user_id = u.id AND da.status = 'validated') AS quests_validated,
         (SELECT COUNT(DISTINCT day_key) FROM daily_assignments da WHERE da.user_id = u.id AND da.status = 'validated') AS active_days_count,
         (SELECT COUNT(DISTINCT fs.item_id) FROM featured_submissions fs WHERE fs.user_id = u.id AND fs.status = 'validated' AND fs.points_awarded > 0) AS featured_stages_count
       FROM users u
       LEFT JOIN points_ledger pl ON pl.user_id = u.id
       GROUP BY u.id
       ORDER BY total_points DESC, async_points DESC, u.created_at ASC`
    )
    .all() as Omit<LeaderboardEntry, 'rank' | 'tmnf_medals_count' | 'tombola_eligible' | 'tombola_progress_pct'>[];

  return rows.map((r, idx) => ({
    rank: idx + 1,
    ...r,
    tmnf_medals_count: r.featured_stages_count,
    tombola_eligible: r.total_points >= threshold,
    tombola_progress_pct: Math.min(100, Math.round((r.total_points / threshold) * 100)),
  }));
}

/**
 * Attribution manuelle de points bonus / ajustement par un Admin dans `points_ledger`.
 */
export function grantManualPoints(
  db: Database.Database,
  params: {
    userId: string;
    points: number;
    category: 'async' | 'live';
    label: string;
  }
): void {
  const pts = Math.round(Number(params.points));
  if (!Number.isFinite(pts) || pts === 0) {
    throw new Error('Le montant de points doit être un entier non nul.');
  }
  const ref = `manual:${params.userId}:${Date.now()}`;
  db.prepare(
    `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label)
     VALUES (?, 'manual', ?, ?, ?, ?)`
  ).run(params.userId, ref, params.category === 'live' ? 'live' : 'async', pts, params.label.trim() || 'Bonus Admin HGW');
}
