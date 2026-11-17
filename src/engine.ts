import type Database from 'better-sqlite3';
import { formatTmTime, parseReplayGbx } from './gbx.js';

export const MIN_SELECTED_GAMES = 4;
export const MAX_WEEKLY_QUESTS_PER_GAME = 5;
export const DAILY_QUESTS_COUNT = 3;
export const TOMBOLA_POINTS_THRESHOLD = 300;

export const MEDAL_POINTS: Record<string, number> = {
  author: 30,
  gold: 20,
  silver: 10,
  bronze: 5,
  none: 0,
};

export const WEEKLY_TMNF_TOP10_POINTS = [150, 110, 80, 50, 50, 50, 30, 30, 30, 30];

/**
 * Calcule la clé du jour (`YYYY-MM-DD`) et de la semaine (`YYYY-Www`) avec bascule à 03h00 Europe/Paris (Décision D1/D10).
 */
export function getParisDayAndWeekKey(now: Date = new Date()): { dayKey: string; weekKey: string } {
  // Décalage de -3 heures pour que 00h00 -> 02h59 appartienne encore à la journée logique de la veille
  const shifted = new Date(now.getTime() - 3 * 3600 * 1000);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dayKey = formatter.format(shifted); // YYYY-MM-DD

  const [y, m, d] = dayKey.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const weekKey = `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;

  return { dayKey, weekKey };
}

/**
 * Mélange aléatoire de Fisher-Yates.
 */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Sauvegarde les jeux cochés par un joueur (min 4 hors Fil Rouge) et tire ses 3 premiers défis s'il n'en a pas encore aujourd'hui.
 */
export function saveUserSelectedGames(
  db: Database.Database,
  userId: string,
  gameIds: string[],
  now: Date = new Date()
): { selectedGames: string[]; assignmentsCreated: number } {
  const validNonUniversal = db
    .prepare(`SELECT id FROM games WHERE is_universal = 0`)
    .all() as { id: string }[];
  const validSet = new Set(validNonUniversal.map((g) => g.id));

  const cleaned = Array.from(new Set(gameIds.filter((id) => validSet.has(id))));
  if (cleaned.length < MIN_SELECTED_GAMES) {
    throw new Error(`Vous devez sélectionner au moins ${MIN_SELECTED_GAMES} jeux (hors Fil Rouge Web Gratuit).`);
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_games WHERE user_id = ?`).run(userId);
    const ins = db.prepare(`INSERT INTO user_games (user_id, game_id) VALUES (?, ?)`);
    for (const gid of cleaned) {
      ins.run(userId, gid);
    }
  });
  tx();

  const { dayKey } = getParisDayAndWeekKey(now);
  const existingToday = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM daily_assignments WHERE user_id = ? AND day_key = ? AND status != 'rerolled'`
    )
    .get(userId, dayKey) as { cnt: number };

  let assignmentsCreated = 0;
  if (existingToday.cnt === 0) {
    const drawn = drawDailyQuestsForUser(db, userId, now);
    assignmentsCreated = drawn.length;
  }

  return { selectedGames: cleaned, assignmentsCreated };
}

/**
 * Algorithme de tirage quotidien stratifié (Section 4.3 + correctif d'équité 1 Facile + 1 Moyen + 1 Difficile = 80 pts/jour).
 * - Cap de 5 défis (`validated + submitted`) par jeu et par semaine.
 * - Priorité aux quêtes jamais tirées cette semaine ; fallback sur les quêtes `expired` si le pool neuf est épuisé.
 * - Maximise la variété des jeux (3 jeux distincts en priorité, max 2 du même jeu).
 */
export function drawDailyQuestsForUser(
  db: Database.Database,
  userId: string,
  now: Date = new Date()
): any[] {
  const { dayKey, weekKey } = getParisDayAndWeekKey(now);

  // Vérifier si le joueur a déjà ses défis du jour
  const currentActive = db
    .prepare(
      `SELECT da.*, q.title, q.description, q.difficulty, q.points, q.game_id, q.proof_hint, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.user_id = ? AND da.day_key = ? AND da.status != 'rerolled'
       ORDER BY da.id ASC`
    )
    .all(userId, dayKey);

  if (currentActive.length >= DAILY_QUESTS_COUNT) {
    return currentActive;
  }

  // Vérifier que le joueur a bien au moins 4 jeux cochés
  const userGameRows = db
    .prepare(`SELECT game_id FROM user_games WHERE user_id = ?`)
    .all(userId) as { game_id: string }[];

  if (userGameRows.length < MIN_SELECTED_GAMES) {
    return [];
  }

  const candidateGameIds = new Set<string>(userGameRows.map((r) => r.game_id));
  candidateGameIds.add('universal'); // Catégorie Fil Rouge incluse d'office (Décision D10)

  // Compter les défis validated + submitted par jeu sur la semaine en cours
  const weeklyCountsRows = db
    .prepare(
      `SELECT q.game_id, COUNT(*) AS cnt
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       WHERE da.user_id = ? AND da.week_key = ? AND da.status IN ('validated', 'submitted')
       GROUP BY q.game_id`
    )
    .all(userId, weekKey) as { game_id: string; cnt: number }[];

  const weeklyGameCount = new Map<string, number>();
  for (const r of weeklyCountsRows) {
    weeklyGameCount.set(r.game_id, r.cnt);
  }

  let eligibleGames = Array.from(candidateGameIds).filter(
    (gid) => (weeklyGameCount.get(gid) || 0) < MAX_WEEKLY_QUESTS_PER_GAME
  );
  // Fallback de sécurité si tous les jeux cochés ont atteint le cap de 5
  if (eligibleGames.length === 0) {
    eligibleGames = ['universal', ...Array.from(candidateGameIds)];
  }

  // Quêtes déjà assignées cette semaine
  const weekAssignedRows = db
    .prepare(`SELECT quest_id, status, day_key FROM daily_assignments WHERE user_id = ? AND week_key = ?`)
    .all(userId, weekKey) as { quest_id: string; status: string; day_key: string }[];

  const neverDrawnExclusion = new Set(weekAssignedRows.map((r) => r.quest_id));
  // Fallback exclusion : exclut uniquement celles validées, en attente ou déjà tirées aujourd'hui
  const hardExclusion = new Set(
    weekAssignedRows
      .filter((r) => r.status === 'validated' || r.status === 'submitted' || r.day_key === dayKey)
      .map((r) => r.quest_id)
  );

  const placeholders = eligibleGames.map(() => '?').join(',');
  const allEligibleQuests = db
    .prepare(
      `SELECT id, game_id, title, description, difficulty, points
       FROM quests
       WHERE active = 1 AND game_id IN (${placeholders})`
    )
    .all(...eligibleGames) as {
    id: string;
    game_id: string;
    title: string;
    description: string;
    difficulty: 'easy' | 'medium' | 'hard';
    points: number;
  }[];

  const freshPool = shuffle(allEligibleQuests.filter((q) => !neverDrawnExclusion.has(q.id)));
  const fallbackPool = shuffle(allEligibleQuests.filter((q) => !hardExclusion.has(q.id)));

  const needed = DAILY_QUESTS_COUNT - currentActive.length;
  const targetDifficulties: ('easy' | 'medium' | 'hard')[] = ['easy', 'medium', 'hard'].slice(0, needed) as (
    | 'easy'
    | 'medium'
    | 'hard'
  )[];

  const chosen: typeof allEligibleQuests = [];
  const chosenIds = new Set<string>(currentActive.map((a: any) => a.quest_id));
  const gameCountToday = new Map<string, number>();
  for (const a of currentActive as any[]) {
    gameCountToday.set(a.game_id, (gameCountToday.get(a.game_id) || 0) + 1);
  }

  const pickOne = (
    pool: typeof allEligibleQuests,
    diff: 'easy' | 'medium' | 'hard' | null,
    maxPerGame: number
  ) => {
    for (const q of pool) {
      if (chosenIds.has(q.id)) continue;
      if (diff && q.difficulty !== diff) continue;
      if ((gameCountToday.get(q.game_id) || 0) >= maxPerGame) continue;
      return q;
    }
    return null;
  };

  for (const targetDiff of targetDifficulties) {
    // 1. Essayer dans freshPool avec 1 défi max par jeu (3 jeux différents)
    let picked =
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
      `SELECT da.*, q.title, q.description, q.difficulty, q.points, q.game_id, q.proof_hint, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.user_id = ? AND da.day_key = ? AND da.status != 'rerolled'
       ORDER BY CASE q.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC`
    )
    .all(userId, dayKey);
}

/**
 * Exécute le reset quotidien de 03h00 :
 * 1. Passe les défis `open` des jours précédents en `expired` (les `submitted` restent en attente de validation).
 * 2. Tire les 3 nouveaux défis pour tous les joueurs inscrits ayant au moins 4 jeux cochés.
 */
export function runNightlyDailyReset(
  db: Database.Database,
  now: Date = new Date()
): { expiredCount: number; usersProcessed: number; questsAssigned: number } {
  const { dayKey } = getParisDayAndWeekKey(now);

  const expireRes = db
    .prepare(`UPDATE daily_assignments SET status = 'expired' WHERE day_key < ? AND status = 'open'`)
    .run(dayKey);

  const eligibleUsers = db
    .prepare(
      `SELECT user_id
       FROM user_games
       GROUP BY user_id
       HAVING COUNT(game_id) >= ?`
    )
    .all(MIN_SELECTED_GAMES) as { user_id: string }[];

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
 * Permet à un joueur de relancer (Reroll) 1 défi `open` par jour pour obtenir un autre défi de MÊME difficulté.
 */
export function rerollDailyAssignment(
  db: Database.Database,
  userId: string,
  assignmentId: number,
  now: Date = new Date()
): any {
  const { dayKey, weekKey } = getParisDayAndWeekKey(now);

  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId) as any;
  if (!user) throw new Error('Utilisateur introuvable.');

  if (user.reroll_day_key === dayKey && user.rerolls_used >= 1) {
    throw new Error('Vous avez déjà utilisé votre Reroll gratuit aujourd’hui (1 reroll max / jour).');
  }

  const assignment = db
    .prepare(
      `SELECT da.*, q.difficulty, q.game_id
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       WHERE da.id = ? AND da.user_id = ?`
    )
    .get(assignmentId, userId) as any;

  if (!assignment) throw new Error('Défi introuvable.');
  if (assignment.day_key !== dayKey) throw new Error('Seuls les défis du jour en cours peuvent être relancés.');
  if (assignment.status !== 'open') throw new Error('Seul un défi non soumis (ouvert) peut être relancé.');

  const userGameRows = db
    .prepare(`SELECT game_id FROM user_games WHERE user_id = ?`)
    .all(userId) as { game_id: string }[];
  const gameIds = ['universal', ...userGameRows.map((r) => r.game_id)];
  const placeholders = gameIds.map(() => '?').join(',');

  const alreadyToday = db
    .prepare(`SELECT quest_id FROM daily_assignments WHERE user_id = ? AND day_key = ?`)
    .all(userId, dayKey) as { quest_id: string }[];
  const excludeIds = new Set(alreadyToday.map((r) => r.quest_id));
  excludeIds.add(assignment.quest_id);

  const candidates = db
    .prepare(
      `SELECT * FROM quests
       WHERE active = 1 AND difficulty = ? AND game_id IN (${placeholders})`
    )
    .all(assignment.difficulty, ...gameIds) as any[];

  const available = shuffle(candidates.filter((c) => !excludeIds.has(c.id)));
  if (available.length === 0) {
    throw new Error('Aucune autre quête de même difficulté disponible pour un reroll.');
  }

  const replacement = available[0];

  const tx = db.transaction(() => {
    db.prepare(`UPDATE daily_assignments SET status = 'rerolled' WHERE id = ?`).run(assignmentId);
    db.prepare(
      `INSERT INTO daily_assignments (user_id, quest_id, day_key, week_key, status)
       VALUES (?, ?, ?, ?, 'open')`
    ).run(userId, replacement.id, dayKey, weekKey);
    db.prepare(`UPDATE users SET reroll_day_key = ?, rerolls_used = 1 WHERE id = ?`).run(dayKey, userId);
  });
  tx();

  return drawDailyQuestsForUser(db, userId, now);
}

/**
 * Soumission d'une preuve (fichier image/clip ou lien externe) pour un défi quotidien.
 */
export function submitDailyProof(
  db: Database.Database,
  params: {
    userId: string;
    assignmentId: number;
    proofUrl?: string;
    proofFile?: string;
    proofNote?: string;
  }
): any {
  const assignment = db
    .prepare(
      `SELECT da.*, q.title, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       WHERE da.id = ? AND da.user_id = ?`
    )
    .get(params.assignmentId, params.userId) as any;

  if (!assignment) {
    throw new Error('Défi introuvable pour cet utilisateur.');
  }
  if (assignment.status !== 'open' && assignment.status !== 'rejected') {
    throw new Error(`Ce défi ne peut plus être soumis (statut actuel : ${assignment.status}).`);
  }

  if (!params.proofFile && !params.proofUrl) {
    throw new Error('Veuillez fournir un fichier (screenshot/clip) ou un lien vidéo externe.');
  }

  // Vérifier le cap de 5 défis par jeu sur la semaine
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       WHERE da.user_id = ? AND da.week_key = ? AND q.game_id = ? AND da.status IN ('validated', 'submitted') AND da.id != ?`
    )
    .get(params.userId, assignment.week_key, assignment.game_id, params.assignmentId) as { cnt: number };

  if (countRow.cnt >= MAX_WEEKLY_QUESTS_PER_GAME) {
    throw new Error(`Vous avez déjà atteint la limite de ${MAX_WEEKLY_QUESTS_PER_GAME} défis validés/soumis sur ce jeu cette semaine.`);
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
     WHERE id = ?`
  ).run(proofType, params.proofUrl || null, params.proofFile || null, params.proofNote || null, params.assignmentId);

  return db
    .prepare(
      `SELECT da.*, q.title, q.description, q.points, q.difficulty, q.game_id, g.name AS game_name, g.emoji AS game_emoji, u.display_name, u.username
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       JOIN users u ON u.id = da.user_id
       WHERE da.id = ?`
    )
    .get(params.assignmentId);
}

/**
 * Validation ou refus d'une preuve de défi quotidien (depuis les boutons Discord #preuves ou le Back-Office Admin).
 */
export function reviewDailyAssignment(
  db: Database.Database,
  params: {
    assignmentId: number;
    action: 'approve' | 'reject';
    reviewerId: string;
    rejectReason?: string;
  }
): any {
  const row = db
    .prepare(
      `SELECT da.*, q.title, q.points, q.difficulty, g.name AS game_name, g.emoji AS game_emoji, u.display_name
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       JOIN users u ON u.id = da.user_id
       WHERE da.id = ?`
    )
    .get(params.assignmentId) as any;

  if (!row) {
    throw new Error(`Défi #${params.assignmentId} introuvable.`);
  }

  const sourceRef = `daily:${row.id}`;

  const tx = db.transaction(() => {
    if (params.action === 'approve') {
      db.prepare(
        `UPDATE daily_assignments
         SET status = 'validated', reviewer_id = ?, reject_reason = NULL, reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(params.reviewerId, row.id);

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
      db.prepare(
        `UPDATE daily_assignments
         SET status = 'rejected', reviewer_id = ?, reject_reason = ?, reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(params.reviewerId, params.rejectReason || 'Preuve incomplète ou non conforme.', row.id);

      db.prepare(`DELETE FROM points_ledger WHERE source_ref = ?`).run(sourceRef);
    }
  });

  tx();

  return db
    .prepare(
      `SELECT da.*, q.title, q.points, q.difficulty, g.name AS game_name, g.emoji AS game_emoji, u.display_name
       FROM daily_assignments da
       JOIN quests q ON q.id = da.quest_id
       JOIN games g ON g.id = q.game_id
       JOIN users u ON u.id = da.user_id
       WHERE da.id = ?`
    )
    .get(params.assignmentId);
}

/**
 * Recalcule automatiquement le Top 10 de la Map Hebdo Trackmania et synchronise `points_ledger`.
 */
export function recalculateWeeklyTmnfLeaderboard(db: Database.Database): any[] {
  const weeklyMap = db.prepare(`SELECT * FROM tmnf_maps WHERE is_weekly = 1 LIMIT 1`).get() as any;
  if (!weeklyMap) return [];

  // Meilleur temps par joueur sur la map hebdo
  const bestRuns = db
    .prepare(
      `SELECT s.user_id, u.display_name, u.avatar, MIN(s.time_ms) AS best_time_ms, s.player_login
       FROM tmnf_submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.map_id = ?
       GROUP BY s.user_id
       ORDER BY best_time_ms ASC, MIN(s.id) ASC`
    )
    .all(weeklyMap.id) as {
    user_id: string;
    display_name: string;
    avatar: string | null;
    best_time_ms: number;
    player_login: string;
  }[];

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM points_ledger WHERE source_type = 'tmnf_weekly'`).run();

    const insertLedger = db.prepare(`
      INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label)
      VALUES (?, 'tmnf_weekly', ?, 'async', ?, ?)
    `);

    bestRuns.forEach((run, idx) => {
      const rank = idx + 1;
      const pts = rank <= WEEKLY_TMNF_TOP10_POINTS.length ? WEEKLY_TMNF_TOP10_POINTS[rank - 1] : 0;
      if (pts > 0) {
        insertLedger.run(
          run.user_id,
          `tmnf_weekly:${run.user_id}`,
          pts,
          `⏱️ Chrono Hebdo TMNF — #${rank} (${formatTmTime(run.best_time_ms)})`
        );
      }
    });
  });

  tx();

  return bestRuns.map((r, i) => ({
    rank: i + 1,
    user_id: r.user_id,
    display_name: r.display_name,
    avatar: r.avatar,
    best_time_ms: r.best_time_ms,
    formatted_time: formatTmTime(r.best_time_ms),
    player_login: r.player_login,
    projected_points: i < WEEKLY_TMNF_TOP10_POINTS.length ? WEEKLY_TMNF_TOP10_POINTS[i] : 0,
  }));
}

/**
 * Traite le dépôt d'un fichier `.Replay.gbx` Trackmania :
 * 1. Parse le binaire + header XML.
 * 2. Vérifie l'unicité SHA-256 (anti-partage de fichier).
 * 3. Vérifie/associe le login TMNF du joueur.
 * 4. Identifie la map par UID (ou par mapId sélectionné si l'UID de la map perso est en cours de config).
 * 5. Calcule la médaille et met à jour `points_ledger` de façon strictement non-cumulative (différentielle).
 */
export function submitTmnfReplay(
  db: Database.Database,
  params: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    explicitMapId?: string;
  }
): {
  parsed: ReturnType<typeof parseReplayGbx>;
  map: any;
  medal: 'author' | 'gold' | 'silver' | 'bronze' | 'none';
  previousPoints: number;
  newPoints: number;
  deltaPoints: number;
  isPersonalBest: boolean;
} {
  const parsed = parseReplayGbx(params.buffer);
  if (!parsed.valid || !parsed.bestTimeMs || !parsed.mapUid) {
    throw new Error(parsed.error || 'Replay .gbx invalide.');
  }

  // Anti-triche #1 : Empreinte SHA-256 unique
  const duplicateHash = db
    .prepare(`SELECT id, user_id FROM tmnf_submissions WHERE replay_sha256 = ?`)
    .get(parsed.sha256) as { id: number; user_id: string } | undefined;
  if (duplicateHash) {
    throw new Error('Ce fichier .Replay.gbx exact a déjà été soumis (partage ou doublon interdit).');
  }

  // Anti-triche #2 : Cohérence du login TMNF du joueur
  const user = db.prepare(`SELECT id, tmnf_login, display_name FROM users WHERE id = ?`).get(params.userId) as any;
  if (!user) throw new Error('Utilisateur introuvable.');

  if (user.tmnf_login && user.tmnf_login.toLowerCase() !== parsed.playerLogin!.toLowerCase()) {
    throw new Error(
      `Ce replay a été enregistré par le compte TMNF "${parsed.playerLogin}", mais votre profil est lié au login "${user.tmnf_login}".`
    );
  }

  // Recherche de la map par UID (ou par mapId explicite)
  let map = db.prepare(`SELECT * FROM tmnf_maps WHERE uid = ?`).get(parsed.mapUid) as any;
  if (!map && params.explicitMapId) {
    const candidate = db.prepare(`SELECT * FROM tmnf_maps WHERE id = ?`).get(params.explicitMapId) as any;
    if (candidate && candidate.uid === parsed.mapUid) {
      map = candidate;
    }
  }

  if (!map) {
    throw new Error(
      `L'UID de la map du replay ("${parsed.mapUid}") ne correspond à aucune des 8 maps Médailles ni à la Map Hebdo HGW.`
    );
  }

  const timeMs = parsed.bestTimeMs;
  let medal: 'author' | 'gold' | 'silver' | 'bronze' | 'none' = 'none';
  if (timeMs <= map.author_ms) medal = 'author';
  else if (timeMs <= map.gold_ms) medal = 'gold';
  else if (timeMs <= map.silver_ms) medal = 'silver';
  else if (timeMs <= map.bronze_ms) medal = 'bronze';

  const medalPoints = map.is_weekly ? 0 : MEDAL_POINTS[medal];

  // Meilleur run précédent du joueur sur cette map
  const prevBest = db
    .prepare(
      `SELECT MIN(time_ms) AS best_time_ms, MAX(points_awarded) AS max_pts
       FROM tmnf_submissions
       WHERE user_id = ? AND map_id = ?`
    )
    .get(params.userId, map.id) as { best_time_ms: number | null; max_pts: number | null };

  const previousPoints = prevBest?.max_pts || 0;
  const newPoints = Math.max(previousPoints, medalPoints);
  const deltaPoints = newPoints - previousPoints;
  const isPersonalBest = prevBest?.best_time_ms === null || timeMs < prevBest.best_time_ms;

  const tx = db.transaction(() => {
    if (!user.tmnf_login && parsed.playerLogin) {
      db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(parsed.playerLogin, params.userId);
    }

    db.prepare(
      `INSERT INTO tmnf_submissions (
        user_id, map_id, time_ms, medal, points_awarded, player_login, player_nickname, replay_sha256, file_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.userId,
      map.id,
      timeMs,
      medal,
      medalPoints,
      parsed.playerLogin,
      parsed.playerNickname || parsed.playerLogin,
      parsed.sha256,
      params.fileName
    );

    if (!map.is_weekly && newPoints > 0) {
      const sourceRef = `tmnf_medal:${params.userId}:${map.id}`;
      const bestMedalLabel =
        newPoints === 30 ? 'Auteur' : newPoints === 20 ? 'Or' : newPoints === 10 ? 'Argent' : 'Bronze';
      const bestTimeAfter = isPersonalBest ? timeMs : prevBest.best_time_ms!;

      db.prepare(
        `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label, updated_at)
         VALUES (?, 'tmnf_medal', ?, 'async', ?, ?, datetime('now'))
         ON CONFLICT(source_ref) DO UPDATE SET
           points = excluded.points,
           label = excluded.label,
           updated_at = datetime('now')`
      ).run(
        params.userId,
        sourceRef,
        newPoints,
        `🏅 TMNF ${map.code} — Médaille ${bestMedalLabel} (${formatTmTime(bestTimeAfter)})`
      );
    }
  });

  tx();

  if (map.is_weekly) {
    recalculateWeeklyTmnfLeaderboard(db);
  }

  return {
    parsed,
    map,
    medal,
    previousPoints,
    newPoints,
    deltaPoints,
    isPersonalBest,
  };
}

/**
 * Algorithme de Tirage d'Équipes Équilibrées par Chapeaux (Pools 1 / 2 / 3) — Section 4.2 :
 * - En 3v3 (RL Rumble) : associe Chapeau 1 + Chapeau 2 + Chapeau 3.
 * - Gère proprement les cas où les pools n'ont pas exactement le même effectif ou si le nombre de joueurs au check-in n'est pas un multiple exact de `teamSize` (distribution serpentin équilibrée par niveau).
 */
export function generateBalancedTeams(
  db: Database.Database,
  tournamentId: string,
  onlyCheckedIn = true
): {
  tournament: any;
  teams: {
    teamNumber: number;
    teamName: string;
    averagePool: number;
    members: { user_id: string; display_name: string; avatar: string | null; pool: number }[];
  }[];
} {
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId) as any;
  if (!tournament) throw new Error('Tournoi introuvable.');

  const teamSize = Math.max(2, tournament.team_size || 3);

  const query = onlyCheckedIn
    ? `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = ? AND tr.checked_in = 1`
    : `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = ?`;

  const players = db.prepare(query).all(tournamentId) as {
    user_id: string;
    display_name: string;
    avatar: string | null;
    pool: number;
  }[];

  if (players.length < 2) {
    throw new Error('Au moins 2 joueurs (enregistrés / check-in) sont requis pour tirer des équipes.');
  }

  // Mélanger l'intérieur de chaque chapeau puis trier par Chapeau (1 -> 2 -> 3)
  const pool1 = shuffle(players.filter((p) => p.pool === 1));
  const pool2 = shuffle(players.filter((p) => p.pool === 2));
  const pool3 = shuffle(players.filter((p) => p.pool === 3));
  const orderedDraft = [...pool1, ...pool2, ...pool3];

  const numTeams = Math.max(1, Math.ceil(orderedDraft.length / teamSize));
  const teamBuckets: {
    teamNumber: number;
    teamName: string;
    members: { user_id: string; display_name: string; avatar: string | null; pool: number }[];
  }[] = [];

  const TEAM_NAMES = [
    'Équipe Alpha ⚡',
    'Équipe Bravo 🔥',
    'Équipe Charlie 🌊',
    'Équipe Delta 🛡️',
    'Équipe Echo 🚀',
    'Équipe Foxtrot 💎',
    'Équipe Golf 🌪️',
    'Équipe Hotel 🌟',
  ];

  for (let i = 0; i < numTeams; i++) {
    teamBuckets.push({
      teamNumber: i + 1,
      teamName: TEAM_NAMES[i] || `Équipe #${i + 1}`,
      members: [],
    });
  }

  // Distribution en serpentin (Snake Draft : 0..N-1 puis N-1..0 puis 0..N-1)
  orderedDraft.forEach((player, index) => {
    const round = Math.floor(index / numTeams);
    const offset = index % numTeams;
    const bucketIdx = round % 2 === 0 ? offset : numTeams - 1 - offset;
    teamBuckets[bucketIdx].members.push(player);
  });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE tournament_registrations SET team_number = NULL, team_name = NULL WHERE tournament_id = ?`).run(
      tournamentId
    );
    const upd = db.prepare(
      `UPDATE tournament_registrations SET team_number = ?, team_name = ? WHERE tournament_id = ? AND user_id = ?`
    );
    for (const t of teamBuckets) {
      for (const m of t.members) {
        upd.run(t.teamNumber, t.teamName, tournamentId, m.user_id);
      }
    }
  });
  tx();

  return {
    tournament,
    teams: teamBuckets.map((t) => ({
      ...t,
      averagePool:
        t.members.length > 0
          ? Number((t.members.reduce((acc, m) => acc + m.pool, 0) / t.members.length).toFixed(2))
          : 0,
    })),
  };
}

/**
 * Attribue le classement final d'un tournoi (et crédite automatiquement `points_ledger` en catégorie `live`).
 */
export function recordTournamentPlacements(
  db: Database.Database,
  tournamentId: string,
  placements: { userId: string; placement: number }[]
): void {
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId) as any;
  if (!tournament) throw new Error('Tournoi introuvable.');

  const scale = JSON.parse(tournament.points_scale_json) as Record<string, number>;

  const tx = db.transaction(() => {
    for (const item of placements) {
      const rank = item.placement;
      const pts = scale[String(rank)] ?? scale.default ?? 0;

      db.prepare(
        `UPDATE tournament_registrations
         SET placement = ?, points_awarded = ?
         WHERE tournament_id = ? AND user_id = ?`
      ).run(rank, pts, tournamentId, item.userId);

      const sourceRef = `tournament:${tournamentId}:${item.userId}`;
      if (pts > 0) {
        db.prepare(
          `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label, updated_at)
           VALUES (?, 'tournament', ?, 'live', ?, ?, datetime('now'))
           ON CONFLICT(source_ref) DO UPDATE SET
             points = excluded.points,
             label = excluded.label,
             updated_at = datetime('now')`
        ).run(
          item.userId,
          sourceRef,
          pts,
          `${tournament.emoji} ${tournament.name} — Place #${rank} (+${pts} pts)`
        );
      }
    }
  });

  tx();
}

/**
 * Sous-barème interne Fall Guys (Section 6 : 5 parties en lobby privé) :
 * Couronne = 10 pts | Finaliste = 6 pts | Qualifié Manche 1 = 3 pts | Éliminé Manche 1 = 1 pt.
 * Calcule le cumul des 5 parties, classe automatiquement tous les participants et distribue les points HGW (200 / 140 / 90 / 50 / 25).
 */
export function updateFallGuysScoresAndRankings(
  db: Database.Database,
  scores: { userId: string; shows: number[] }[]
): any[] {
  const tx = db.transaction(() => {
    for (const entry of scores) {
      const normalized = [0, 1, 2, 3, 4].map((i) => {
        const val = Number(entry.shows[i] || 0);
        return Number.isFinite(val) && val >= 0 ? val : 0;
      });
      const total = normalized.reduce((a, b) => a + b, 0);

      db.prepare(
        `UPDATE tournament_registrations
         SET fg_shows_json = ?, fg_total_score = ?, checked_in = 1
         WHERE tournament_id = 'fall_guys' AND user_id = ?`
      ).run(JSON.stringify(normalized), total, entry.userId);
    }
  });
  tx();

  const rows = db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = 'fall_guys' AND tr.checked_in = 1
       ORDER BY tr.fg_total_score DESC, tr.registered_at ASC`
    )
    .all() as any[];

  const placements = rows.map((r, idx) => ({
    userId: r.user_id,
    placement: idx + 1,
  }));

  if (placements.length > 0) {
    recordTournamentPlacements(db, 'fall_guys', placements);
  }

  return db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = 'fall_guys'
       ORDER BY tr.fg_total_score DESC, tr.registered_at ASC`
    )
    .all();
}

/**
 * Classement général HGW (50% Async / 50% Live + éligibilité Tombola >= 300 pts).
 */
export function getGlobalLeaderboard(db: Database.Database): any[] {
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
         (SELECT COUNT(DISTINCT map_id) FROM tmnf_submissions ts WHERE ts.user_id = u.id AND ts.points_awarded > 0) AS tmnf_medals_count
       FROM users u
       LEFT JOIN points_ledger pl ON pl.user_id = u.id
       GROUP BY u.id
       ORDER BY total_points DESC, async_points DESC, u.created_at ASC`
    )
    .all() as any[];

  return rows.map((r, idx) => ({
    rank: idx + 1,
    ...r,
    tombola_eligible: r.total_points >= TOMBOLA_POINTS_THRESHOLD,
    tombola_progress_pct: Math.min(100, Math.round((r.total_points / TOMBOLA_POINTS_THRESHOLD) * 100)),
  }));
}
