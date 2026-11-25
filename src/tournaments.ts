import type Database from 'better-sqlite3';
import { getEventConfig } from './config.js';
import { slugify } from './catalog.js';

// ============================================================================
// TOURNOIS DU WEEK-END — CRUD + CHAPEAUX + ÉQUIPES + SCORING DIRECT / MANCHES
// ============================================================================

export type ScoringMode = 'direct' | 'rounds';

export interface RoundPreset {
  label: string;
  points: number;
}

export interface TournamentInput {
  id?: string;
  name?: string;
  emoji?: string;
  game_id?: string;
  scheduled_label?: string;
  scheduled_iso?: string;
  mode_label?: string;
  team_size?: number;
  is_major?: boolean | number;
  scoring_mode?: ScoringMode;
  rounds_count?: number;
  round_presets?: RoundPreset[];
  bracket_url?: string | null;
  points_scale?: Record<string, number>;
  status?: 'upcoming' | 'checkin' | 'live' | 'completed';
  active?: boolean | number;
  sort_order?: number;
}

const TEAM_NAMES = [
  'Équipe Alpha ⚡',
  'Équipe Bravo 🔥',
  'Équipe Charlie 🌊',
  'Équipe Delta 🛡️',
  'Équipe Echo 🚀',
  'Équipe Foxtrot 💎',
  'Équipe Golf 🌪️',
  'Équipe Hotel 🌟',
  'Équipe India 🎯',
  'Équipe Juliet ⚔️',
];

function shuffle<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeBracketUrl(raw: unknown): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Lien de bracket invalide (utilisez une URL http:// ou https://).');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Le lien de bracket doit commencer par https:// ou http://.');
  }
  return u.toString().slice(0, 400);
}

function normalizePointsScale(raw: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!raw || typeof raw !== 'object') return fallback;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^(\d+|default)$/.test(k)) continue;
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 0 && n <= 10000) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

function normalizePresets(raw: unknown): RoundPreset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && String(p.label || '').trim() !== '' && Number.isFinite(Number(p.points)))
    .map((p) => ({
      label: String(p.label).trim().slice(0, 30),
      points: Math.max(0, Math.min(1000, Math.trunc(Number(p.points)))),
    }))
    .slice(0, 10);
}

function uniqueTournamentId(db: Database.Database, base: string): string {
  let id = base || `tournoi_${Date.now()}`;
  let i = 2;
  const exists = db.prepare(`SELECT 1 FROM tournaments WHERE id = ?`);
  while (exists.get(id)) id = `${base}_${i++}`;
  return id;
}

export function hydrateTournament(row: any, registrations: any[] = []) {
  let points_scale: Record<string, number> = {};
  let round_presets: RoundPreset[] = [];
  try {
    points_scale = JSON.parse(row.points_scale_json || '{}');
  } catch {
    points_scale = {};
  }
  try {
    round_presets = JSON.parse(row.round_presets_json || '[]');
  } catch {
    round_presets = [];
  }

  return {
    ...row,
    active: row.active === undefined ? 1 : row.active,
    scoring_mode: row.scoring_mode === 'rounds' ? 'rounds' : 'direct',
    rounds_count: Math.max(1, Number(row.rounds_count || 5)),
    points_scale,
    round_presets,
    registrations: registrations.map((r) => {
      let roundScores: number[] = [];
      try {
        const parsed = JSON.parse(r.round_scores_json || r.fg_shows_json || '[]');
        if (Array.isArray(parsed)) roundScores = parsed.map((n) => Number(n) || 0);
      } catch {
        roundScores = [];
      }
      return {
        ...r,
        round_scores: roundScores,
        round_total_score: Number(r.round_total_score ?? r.fg_total_score ?? 0),
        fg_shows: roundScores,
      };
    }),
  };
}

export function listTournamentsWithRegistrations(db: Database.Database, includeInactive = false) {
  const tournaments = db
    .prepare(
      includeInactive
        ? `SELECT * FROM tournaments ORDER BY sort_order ASC, name ASC`
        : `SELECT * FROM tournaments WHERE active = 1 ORDER BY sort_order ASC, name ASC`
    )
    .all() as any[];

  const allRegs = db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       ORDER BY tr.pool ASC, tr.registered_at ASC`
    )
    .all() as any[];

  return tournaments.map((t) =>
    hydrateTournament(
      t,
      allRegs.filter((r) => r.tournament_id === t.id)
    )
  );
}

export function createTournament(db: Database.Database, input: TournamentInput) {
  const cfg = getEventConfig(db);
  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 90) {
    throw new Error('Le nom du tournoi doit contenir entre 2 et 90 caractères.');
  }

  const emoji = String(input.emoji || '🏆').trim().slice(0, 16) || '🏆';
  const gameId = String(input.game_id || '').trim().slice(0, 60);
  const scheduledLabel = String(input.scheduled_label || '').trim().slice(0, 120);
  const scheduledIso = String(input.scheduled_iso || '').trim().slice(0, 40);
  const modeLabel = String(input.mode_label || '').trim().slice(0, 200);
  const teamSize = Math.max(1, Math.min(10, Math.trunc(Number(input.team_size || 1))));
  const isMajor = input.is_major ? 1 : 0;
  const scoringMode: ScoringMode = input.scoring_mode === 'rounds' ? 'rounds' : 'direct';
  const roundsCount = scoringMode === 'rounds' ? Math.max(1, Math.min(15, Math.trunc(Number(input.rounds_count || 5)))) : 1;
  const roundPresets = normalizePresets(input.round_presets);
  const bracketUrl = normalizeBracketUrl(input.bracket_url);
  const pointsScale = normalizePointsScale(input.points_scale, cfg.default_tournament_scale);
  const active = input.active === undefined ? 1 : input.active ? 1 : 0;

  const maxOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM tournaments`).get() as { m: number }).m;
  const sortOrder = input.sort_order !== undefined && Number.isFinite(Number(input.sort_order))
    ? Math.trunc(Number(input.sort_order))
    : maxOrder + 1;
  const id = uniqueTournamentId(db, slugify(input.id || name));

  db.prepare(
    `INSERT INTO tournaments (
      id, name, emoji, game_id, scheduled_label, scheduled_iso, mode_label, team_size, is_major,
      scoring_mode, rounds_count, round_presets_json, bracket_url, points_scale_json, status, active, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming', ?, ?)`
  ).run(
    id,
    name,
    emoji,
    gameId,
    scheduledLabel,
    scheduledIso,
    modeLabel,
    teamSize,
    isMajor,
    scoringMode,
    roundsCount,
    JSON.stringify(roundPresets),
    bracketUrl,
    JSON.stringify(pointsScale),
    active,
    sortOrder
  );

  return hydrateTournament(db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id), []);
}

export function updateTournament(db: Database.Database, id: string, input: TournamentInput) {
  const existing = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id) as any;
  if (!existing) throw new Error('Tournoi introuvable.');

  const currentScale = JSON.parse(existing.points_scale_json || '{}');
  const currentPresets = JSON.parse(existing.round_presets_json || '[]');

  const name = input.name !== undefined ? String(input.name).trim() : existing.name;
  if (name.length < 2 || name.length > 90) {
    throw new Error('Le nom du tournoi doit contenir entre 2 et 90 caractères.');
  }

  const scoringMode: ScoringMode =
    input.scoring_mode !== undefined
      ? input.scoring_mode === 'rounds'
        ? 'rounds'
        : 'direct'
      : existing.scoring_mode;

  const next = {
    name,
    emoji: input.emoji !== undefined ? String(input.emoji).trim().slice(0, 16) || '🏆' : existing.emoji,
    game_id: input.game_id !== undefined ? String(input.game_id).trim().slice(0, 60) : existing.game_id,
    scheduled_label: input.scheduled_label !== undefined ? String(input.scheduled_label).trim().slice(0, 120) : existing.scheduled_label,
    scheduled_iso: input.scheduled_iso !== undefined ? String(input.scheduled_iso).trim().slice(0, 40) : existing.scheduled_iso,
    mode_label: input.mode_label !== undefined ? String(input.mode_label).trim().slice(0, 200) : existing.mode_label,
    team_size:
      input.team_size !== undefined
        ? Math.max(1, Math.min(10, Math.trunc(Number(input.team_size || 1))))
        : existing.team_size,
    is_major: input.is_major !== undefined ? (input.is_major ? 1 : 0) : existing.is_major,
    scoring_mode: scoringMode,
    rounds_count:
      input.rounds_count !== undefined
        ? Math.max(1, Math.min(15, Math.trunc(Number(input.rounds_count || 5))))
        : existing.rounds_count,
    round_presets_json:
      input.round_presets !== undefined
        ? JSON.stringify(normalizePresets(input.round_presets))
        : JSON.stringify(currentPresets),
    bracket_url: input.bracket_url !== undefined ? normalizeBracketUrl(input.bracket_url) : existing.bracket_url,
    points_scale_json:
      input.points_scale !== undefined
        ? JSON.stringify(normalizePointsScale(input.points_scale, currentScale))
        : existing.points_scale_json,
    status:
      input.status && ['upcoming', 'checkin', 'live', 'completed'].includes(input.status)
        ? input.status
        : existing.status,
    active: input.active !== undefined ? (input.active ? 1 : 0) : existing.active,
    sort_order:
      input.sort_order !== undefined && Number.isFinite(Number(input.sort_order))
        ? Math.trunc(Number(input.sort_order))
        : existing.sort_order,
  };

  db.prepare(
    `UPDATE tournaments SET
      name = @name, emoji = @emoji, game_id = @game_id, scheduled_label = @scheduled_label,
      scheduled_iso = @scheduled_iso, mode_label = @mode_label, team_size = @team_size,
      is_major = @is_major, scoring_mode = @scoring_mode, rounds_count = @rounds_count,
      round_presets_json = @round_presets_json, bracket_url = @bracket_url,
      points_scale_json = @points_scale_json, status = @status, active = @active, sort_order = @sort_order
     WHERE id = @id`
  ).run({ ...next, id });

  const regs = db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = ? ORDER BY tr.pool ASC, tr.registered_at ASC`
    )
    .all(id);
  return hydrateTournament(db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id), regs);
}

export function deleteTournament(db: Database.Database, id: string): { deleted: true } {
  const existing = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id);
  if (!existing) throw new Error('Tournoi introuvable.');

  const regs = (
    db.prepare(`SELECT COUNT(*) AS c FROM tournament_registrations WHERE tournament_id = ?`).get(id) as { c: number }
  ).c;
  const ledger = (
    db.prepare(`SELECT COUNT(*) AS c FROM points_ledger WHERE source_ref LIKE ?`).get(`tournament:${id}:%`) as { c: number }
  ).c;

  if (regs > 0 || ledger > 0) {
    throw new Error(
      `Ce tournoi a déjà des inscrits (${regs}) ou des points attribués. Désactive-le plutôt pour conserver l’historique.`
    );
  }

  db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(id);
  return { deleted: true };
}

/**
 * Met à jour le chapeau, la présence, et/ou l'équipe manuelle d'un joueur inscrit à un tournoi.
 */
export function updateTournamentPlayer(
  db: Database.Database,
  tournamentId: string,
  params: {
    userId: string;
    pool?: number;
    checkedIn?: boolean;
    teamNumber?: number | null;
    teamName?: string | null;
  }
): void {
  const reg = db
    .prepare(`SELECT * FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?`)
    .get(tournamentId, params.userId);
  if (!reg) throw new Error('Inscription introuvable pour ce joueur.');

  if (params.pool !== undefined) {
    const p = Number(params.pool);
    if ([1, 2, 3].includes(p)) {
      db.prepare(`UPDATE tournament_registrations SET pool = ? WHERE tournament_id = ? AND user_id = ?`).run(
        p,
        tournamentId,
        params.userId
      );
    }
  }
  if (params.checkedIn !== undefined) {
    db.prepare(`UPDATE tournament_registrations SET checked_in = ? WHERE tournament_id = ? AND user_id = ?`).run(
      params.checkedIn ? 1 : 0,
      tournamentId,
      params.userId
    );
  }
  if (params.teamNumber !== undefined) {
    if (params.teamNumber === null || Number(params.teamNumber) <= 0) {
      db.prepare(
        `UPDATE tournament_registrations SET team_number = NULL, team_name = NULL WHERE tournament_id = ? AND user_id = ?`
      ).run(tournamentId, params.userId);
    } else {
      const tNum = Math.max(1, Math.min(20, Math.trunc(Number(params.teamNumber))));
      const tName =
        (params.teamName && String(params.teamName).trim()) || TEAM_NAMES[tNum - 1] || `Équipe #${tNum}`;
      db.prepare(
        `UPDATE tournament_registrations SET team_number = ?, team_name = ? WHERE tournament_id = ? AND user_id = ?`
      ).run(tNum, tName, tournamentId, params.userId);
    }
  }
}

/**
 * Algorithme de Tirage d'Équipes Équilibrées par Chapeaux (Pools 1 / 2 / 3) :
 * Fonctionne pour n'importe quel tournoi par équipes (2v2, 3v3, 4v4...).
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

  const teamSize = Math.max(2, tournament.team_size || 2);

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

  for (let i = 0; i < numTeams; i++) {
    teamBuckets.push({
      teamNumber: i + 1,
      teamName: TEAM_NAMES[i] || `Équipe #${i + 1}`,
      members: [],
    });
  }

  // Distribution en serpentin (Snake Draft)
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
 * Attribue le classement final d'un tournoi et crédite `points_ledger` en catégorie `live`.
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
      } else {
        db.prepare(`DELETE FROM points_ledger WHERE source_ref = ?`).run(sourceRef);
      }
    }
  });

  tx();
}

/**
 * Scoring multi-manches générique (Fall Guys 5 Shows, Mario Kart GP, GeoGuessr N rounds, etc.).
 * Calcule le total des N manches, classe les participants et attribue automatiquement les points HGW.
 */
export function updateTournamentRoundScores(
  db: Database.Database,
  tournamentId: string,
  scores: { userId: string; scores: number[] }[]
): any[] {
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId) as any;
  if (!tournament) throw new Error('Tournoi introuvable.');

  const roundsCount = Math.max(1, Math.min(15, Number(tournament.rounds_count || 5)));

  const tx = db.transaction(() => {
    for (const entry of scores) {
      const normalized = Array.from({ length: roundsCount }, (_, i) => {
        const val = Number(entry.scores[i] || 0);
        return Number.isFinite(val) && val >= 0 ? val : 0;
      });
      const total = normalized.reduce((a, b) => a + b, 0);
      const json = JSON.stringify(normalized);

      db.prepare(
        `UPDATE tournament_registrations
         SET round_scores_json = ?, round_total_score = ?, fg_shows_json = ?, fg_total_score = ?, checked_in = 1
         WHERE tournament_id = ? AND user_id = ?`
      ).run(json, total, json, total, tournamentId, entry.userId);
    }
  });
  tx();

  const rows = db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = ? AND tr.checked_in = 1
       ORDER BY tr.round_total_score DESC, tr.registered_at ASC`
    )
    .all(tournamentId) as any[];

  const placements = rows.map((r, idx) => ({
    userId: r.user_id,
    placement: idx + 1,
  }));

  if (placements.length > 0) {
    recordTournamentPlacements(db, tournamentId, placements);
  }

  return db
    .prepare(
      `SELECT tr.*, u.display_name, u.avatar
       FROM tournament_registrations tr
       JOIN users u ON u.id = tr.user_id
       WHERE tr.tournament_id = ?
       ORDER BY tr.round_total_score DESC, tr.registered_at ASC`
    )
    .all(tournamentId);
}
