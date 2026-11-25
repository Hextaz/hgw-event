import type Database from 'better-sqlite3';
import { getEventConfig } from './config.js';
import type { Difficulty, GameRow, GameWithStatsRow, QuestRow, QuestWithStatsRow } from './types.js';

export type { Difficulty };

// ============================================================================
// CATALOGUE JEUX & DÉFIS — CRUD + DIAGNOSTIC DE SANTÉ + IMPORT / EXPORT JSON
// ----------------------------------------------------------------------------
// Règles :
// - Les points d'un défi découlent du barème global de l'édition (config admin).
// - Un défi déjà tiré à au moins un joueur ne peut pas être supprimé : on l'archive.
// - Même logique pour un jeu : suppression seulement s'il n'a jamais servi,
//   sinon désactivation (masqué des joueurs, exclu du tirage, défis conservés).
// ============================================================================

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

export interface GameInput {
  id?: string;
  name?: string;
  short_name?: string;
  emoji?: string;
  platforms?: string;
  logo_url?: string | null;
  active?: boolean | number;
  sort_order?: number;
}

export interface QuestInput {
  id?: string;
  game_id?: string;
  title?: string;
  description?: string;
  difficulty?: string;
  proof_hint?: string;
  unlock_week?: number;
  active?: boolean | number;
}

function str(v: unknown, field: string, { min = 1, max = 200, required = true } = {}): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new Error(`Le champ « ${field} » est obligatoire.`);
    return undefined;
  }
  const s = String(v).trim();
  if (s.length < min) throw new Error(`Le champ « ${field} » doit faire au moins ${min} caractère${min > 1 ? 's' : ''}.`);
  if (s.length > max) throw new Error(`Le champ « ${field} » ne doit pas dépasser ${max} caractères.`);
  return s;
}

export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Accepte une URL https externe ou un logo hébergé localement (/uploads/logos/…). Rejette tout le reste (javascript:, data:, http…). */
export function normalizeLogoUrl(v: unknown): string | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).trim();
  if (/^\/uploads\/logos\/[a-z0-9_.-]+$/i.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('URL de logo invalide.');
  }
  if (url.protocol !== 'https:') throw new Error('Le logo doit être servi en https.');
  if (s.length > 500) throw new Error('URL de logo trop longue.');
  return url.toString();
}

function uniqueId(db: Database.Database, table: 'games' | 'quests', base: string): string {
  let id = base || `${table}_${Date.now()}`;
  let i = 2;
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  while (exists.get(id)) id = `${base}_${i++}`;
  return id;
}

// ---------------------------------------------------------------------------
// LECTURE & DIAGNOSTIC DE SANTÉ
// ---------------------------------------------------------------------------

export function computeCatalogHealth(db: Database.Database, games: GameWithStatsRow[], quests: QuestWithStatsRow[]) {
  const cfg = getEventConfig(db);
  const selectableActive = games.filter((g) => !g.is_universal && g.active && g.active_quest_count > 0);
  const warnings: { level: 'danger' | 'warn'; gameId?: string; message: string }[] = [];

  if (selectableActive.length < cfg.min_selected_games) {
    warnings.push({
      level: 'danger',
      message: `Seulement ${selectableActive.length} jeu(x) actif(s) avec défis, alors que les joueurs doivent en cocher au moins ${cfg.min_selected_games}.`,
    });
  }

  for (const g of games) {
    if (!g.active) continue;
    const gq = quests.filter((q) => q.game_id === g.id && q.active);
    if (gq.length === 0) {
      warnings.push({
        level: 'warn',
        gameId: g.id,
        message: `${g.short_name} est actif mais n'a aucun défi actif (il ne sera pas proposé aux joueurs).`,
      });
      continue;
    }
    const missingAct1 = DIFFICULTIES.filter((d) => !gq.some((q) => q.difficulty === d && (q.unlock_week || 1) <= 1));
    if (missingAct1.length > 0) {
      const labels = missingAct1.map((d) => (d === 'easy' ? 'Facile' : d === 'medium' ? 'Moyen' : 'Difficile')).join(', ');
      warnings.push({
        level: 'warn',
        gameId: g.id,
        message: `${g.short_name} : aucun défi ${labels} disponible dès l'Acte I.`,
      });
    }
  }

  return {
    actsCount: cfg.acts_count,
    minSelectedGames: cfg.min_selected_games,
    activeGamesCount: selectableActive.length,
    totalActiveQuests: quests.filter((q) => q.active).length,
    warnings,
    healthy: warnings.filter((w) => w.level === 'danger').length === 0,
  };
}

export function listCatalog(db: Database.Database) {
  const cfg = getEventConfig(db);
  const games = db
    .prepare(
      `SELECT g.*,
         (SELECT COUNT(*) FROM quests q WHERE q.game_id = g.id) AS quest_count,
         (SELECT COUNT(*) FROM quests q WHERE q.game_id = g.id AND q.active = 1) AS active_quest_count,
         (SELECT COUNT(*) FROM user_games ug WHERE ug.game_id = g.id) AS player_count,
         (SELECT COUNT(*) FROM daily_assignments da JOIN quests q ON q.id = da.quest_id WHERE q.game_id = g.id) AS usage_count
       FROM games g
       ORDER BY g.sort_order ASC, g.name ASC`
    )
    .all() as GameWithStatsRow[];

  const quests = db
    .prepare(
      `SELECT q.*,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id) AS usage_count,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id AND da.status = 'validated') AS validated_count,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id AND da.status = 'rerolled') AS rerolled_count
       FROM quests q
       ORDER BY q.game_id ASC, CASE q.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC, q.unlock_week ASC, q.title ASC`
    )
    .all() as QuestWithStatsRow[];

  return {
    games,
    quests,
    pointsByDifficulty: cfg.quest_points,
    actsCount: cfg.acts_count,
    acts: cfg.acts,
    health: computeCatalogHealth(db, games, quests),
  };
}

// ---------------------------------------------------------------------------
// IMPORT / EXPORT JSON DU CATALOGUE
// ---------------------------------------------------------------------------

export function exportCatalog(db: Database.Database, gameId?: string) {
  const games = (
    gameId
      ? db
          .prepare(`SELECT id, name, short_name, emoji, platforms, is_universal, logo_url, active, sort_order FROM games WHERE id = ?`)
          .all(gameId)
      : db
          .prepare(`SELECT id, name, short_name, emoji, platforms, is_universal, logo_url, active, sort_order FROM games ORDER BY sort_order ASC`)
          .all()
  ) as GameRow[];

  const quests = (
    gameId
      ? db.prepare(`SELECT id, game_id, title, description, difficulty, proof_hint, unlock_week, active FROM quests WHERE game_id = ?`).all(gameId)
      : db
          .prepare(`SELECT id, game_id, title, description, difficulty, proof_hint, unlock_week, active FROM quests ORDER BY game_id ASC, unlock_week ASC`)
          .all()
  ) as Omit<QuestRow, 'points'>[];

  return {
    format: 'hgw-catalog-v1',
    exportedAt: new Date().toISOString(),
    games,
    quests,
  };
}

export function importCatalog(
  db: Database.Database,
  payload: { games?: GameInput[]; quests?: QuestInput[]; mode?: 'merge' | 'overwrite_matching' }
): { gamesCreated: number; gamesUpdated: number; questsCreated: number; questsUpdated: number; skipped: number } {
  if (!payload || (!Array.isArray(payload.games) && !Array.isArray(payload.quests))) {
    throw new Error('Format JSON invalide : attendez un objet contenant `games` et/ou `quests`.');
  }

  const cfg = getEventConfig(db);
  const overwrite = payload.mode === 'overwrite_matching';
  let gamesCreated = 0;
  let gamesUpdated = 0;
  let questsCreated = 0;
  let questsUpdated = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    const incomingGames = Array.isArray(payload.games) ? payload.games : [];
    for (const g of incomingGames) {
      const name = String(g?.name || '').trim().slice(0, 80);
      if (name.length < 2) {
        skipped++;
        continue;
      }
      const shortName = String(g?.short_name || name).trim().slice(0, 30) || name.slice(0, 30);
      const id = slugify(String(g?.id || shortName));
      if (!id) {
        skipped++;
        continue;
      }
      const existing = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameRow | undefined;
      const emoji = String(g?.emoji || '🎮').trim().slice(0, 16) || '🎮';
      const platforms = String(g?.platforms || '').trim().slice(0, 200);
      let logoUrl: string | null | undefined;
      if (g?.logo_url !== undefined) {
        try {
          logoUrl = normalizeLogoUrl(g.logo_url);
        } catch {
          logoUrl = null;
        }
      }
      const active = g?.active === undefined ? 1 : g.active ? 1 : 0;

      if (existing) {
        if (overwrite) {
          const nextLogo = logoUrl !== undefined ? logoUrl : existing.logo_url;
          db.prepare(
            `UPDATE games SET name = ?, short_name = ?, emoji = ?, platforms = ?, logo_url = ?, active = CASE WHEN is_universal = 1 THEN 1 ELSE ? END WHERE id = ?`
          ).run(name, shortName, emoji, platforms, nextLogo, active, id);
          gamesUpdated++;
        } else {
          skipped++;
        }
      } else {
        const maxOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM games WHERE is_universal = 0`).get() as { m: number }).m;
        db.prepare(
          `INSERT INTO games (id, name, short_name, emoji, platforms, is_universal, sort_order, logo_url, active)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
        ).run(id, name, shortName, emoji, platforms, maxOrder + 1, logoUrl ?? null, active);
        db.prepare(`UPDATE games SET sort_order = ? WHERE is_universal = 1`).run(maxOrder + 2);
        gamesCreated++;
      }
    }

    const incomingQuests = Array.isArray(payload.quests) ? payload.quests : [];
    for (const q of incomingQuests) {
      const gameId = String(q?.game_id || '').trim();
      const title = String(q?.title || '').trim().slice(0, 80);
      const description = String(q?.description || '').trim().slice(0, 500);
      const difficulty = String(q?.difficulty || '').trim() as Difficulty;
      if (!gameId || title.length < 3 || description.length < 10 || !DIFFICULTIES.includes(difficulty)) {
        skipped++;
        continue;
      }
      if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(gameId)) {
        skipped++;
        continue;
      }
      const proofHint = String(q?.proof_hint || 'Screenshot de fin de partie ou clip vidéo (15s)').trim().slice(0, 200);
      const unlockWeek = Math.max(1, Math.min(3, Math.trunc(Number(q?.unlock_week || 1))));
      const active = q?.active === undefined ? 1 : q.active ? 1 : 0;
      const points = cfg.quest_points[difficulty];

      const explicitId = q?.id ? slugify(String(q.id)) : '';
      const existingById = explicitId ? (db.prepare(`SELECT * FROM quests WHERE id = ?`).get(explicitId) as QuestRow | undefined) : undefined;
      const existingByTitle = !existingById
        ? (db.prepare(`SELECT * FROM quests WHERE game_id = ? AND LOWER(title) = LOWER(?)`).get(gameId, title) as QuestRow | undefined)
        : undefined;
      const existing = existingById || existingByTitle;

      if (existing) {
        if (overwrite) {
          const locked = (
            db
              .prepare(`SELECT COUNT(*) AS c FROM daily_assignments WHERE quest_id = ? AND status IN ('validated', 'submitted')`)
              .get(existing.id) as { c: number }
          ).c > 0;
          const nextDifficulty = locked ? existing.difficulty : difficulty;
          const nextPoints = cfg.quest_points[nextDifficulty];
          db.prepare(
            `UPDATE quests SET title = ?, description = ?, difficulty = ?, points = ?, proof_hint = ?, unlock_week = ?, active = ? WHERE id = ?`
          ).run(title, description, nextDifficulty, nextPoints, proofHint, unlockWeek, active, existing.id);
          questsUpdated++;
        } else {
          skipped++;
        }
      } else {
        const newId = uniqueId(db, 'quests', explicitId || `${gameId}_${difficulty}_${slugify(title).slice(0, 24)}`);
        db.prepare(
          `INSERT INTO quests (id, game_id, title, description, difficulty, points, proof_hint, unlock_week, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(newId, gameId, title, description, difficulty, points, proofHint, unlockWeek, active);
        questsCreated++;
      }
    }
  });

  tx();
  return { gamesCreated, gamesUpdated, questsCreated, questsUpdated, skipped };
}

// ---------------------------------------------------------------------------
// JEUX
// ---------------------------------------------------------------------------

export function createGame(db: Database.Database, input: GameInput): GameRow {
  const name = str(input.name, 'Nom', { min: 2, max: 80 })!;
  const short_name = str(input.short_name || name, 'Nom court', { min: 2, max: 30 })!;
  const emoji = str(input.emoji || '🎮', 'Emoji', { max: 16 })!;
  const platforms = str(input.platforms || '', 'Plateformes', { min: 0, max: 200 }) ?? '';
  const logo_url = normalizeLogoUrl(input.logo_url);
  const id = uniqueId(db, 'games', slugify(input.id || short_name));
  const maxOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM games WHERE is_universal = 0`).get() as { m: number }).m;

  db.prepare(
    `INSERT INTO games (id, name, short_name, emoji, platforms, is_universal, sort_order, logo_url, active)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1)`
  ).run(id, name, short_name, emoji, platforms, maxOrder + 1, logo_url);

  // Garde le Fil Rouge en dernier
  db.prepare(`UPDATE games SET sort_order = ? WHERE is_universal = 1`).run(maxOrder + 2);
  return db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameRow;
}

export function updateGame(db: Database.Database, id: string, input: GameInput): GameRow {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameRow | undefined;
  if (!game) throw new Error('Jeu introuvable.');

  const next = {
    name: input.name !== undefined ? str(input.name, 'Nom', { min: 2, max: 80 }) : game.name,
    short_name: input.short_name !== undefined ? str(input.short_name, 'Nom court', { min: 2, max: 30 }) : game.short_name,
    emoji: input.emoji !== undefined ? str(input.emoji, 'Emoji', { max: 16 }) : game.emoji,
    platforms: input.platforms !== undefined ? str(input.platforms, 'Plateformes', { min: 0, max: 200 }) : game.platforms,
    logo_url: input.logo_url !== undefined ? normalizeLogoUrl(input.logo_url) : game.logo_url,
    active: input.active !== undefined ? (input.active ? 1 : 0) : game.active,
    sort_order: input.sort_order !== undefined && Number.isFinite(Number(input.sort_order)) ? Math.trunc(Number(input.sort_order)) : game.sort_order,
  };
  if (game.is_universal && !next.active) {
    throw new Error('Le Fil Rouge est inclus d’office pour tous les joueurs : il ne peut pas être désactivé.');
  }

  db.prepare(
    `UPDATE games SET name = @name, short_name = @short_name, emoji = @emoji, platforms = @platforms,
       logo_url = @logo_url, active = @active, sort_order = @sort_order
     WHERE id = @id`
  ).run({ ...next, id });
  return db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameRow;
}

/** Supprime un jeu jamais utilisé. Retourne l'ancien logo pour permettre son nettoyage disque. */
export function deleteGame(db: Database.Database, id: string): { deleted: true; logo_url: string | null } {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as GameRow | undefined;
  if (!game) throw new Error('Jeu introuvable.');
  if (game.is_universal) throw new Error('Le Fil Rouge ne peut pas être supprimé.');

  const used = db
    .prepare(`SELECT COUNT(*) AS c FROM daily_assignments da JOIN quests q ON q.id = da.quest_id WHERE q.game_id = ?`)
    .get(id) as { c: number };
  const players = db.prepare(`SELECT COUNT(*) AS c FROM user_games WHERE game_id = ?`).get(id) as { c: number };
  const tournaments = db.prepare(`SELECT COUNT(*) AS c FROM tournaments WHERE game_id = ?`).get(id) as { c: number };
  if (used.c > 0 || players.c > 0 || tournaments.c > 0) {
    const why = [
      used.c ? `${used.c} défi${used.c > 1 ? 's' : ''} déjà tiré${used.c > 1 ? 's' : ''}` : '',
      players.c ? `${players.c} joueur${players.c > 1 ? 's' : ''} l’${players.c > 1 ? 'ont' : 'a'} coché` : '',
      tournaments.c ? 'un tournoi y est rattaché' : '',
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(`Ce jeu a déjà servi (${why}). Désactive-le plutôt : l’historique et les points sont conservés.`);
  }

  db.prepare(`DELETE FROM games WHERE id = ?`).run(id);
  return { deleted: true, logo_url: game.logo_url };
}

// ---------------------------------------------------------------------------
// DÉFIS
// ---------------------------------------------------------------------------

function parseDifficulty(v: unknown): Difficulty {
  if (!DIFFICULTIES.includes(v as Difficulty)) throw new Error('Difficulté invalide (facile, moyen ou difficile).');
  return v as Difficulty;
}

function parseAct(v: unknown): number {
  const w = Number(v ?? 1);
  if (w !== 1 && w !== 2 && w !== 3) throw new Error('L’acte doit valoir 1, 2 ou 3.');
  return w;
}

export function createQuest(db: Database.Database, input: QuestInput): QuestRow {
  const cfg = getEventConfig(db);
  const game_id = str(input.game_id, 'Jeu')!;
  if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(game_id)) throw new Error('Jeu introuvable.');
  const title = str(input.title, 'Titre', { min: 3, max: 80 })!;
  const description = str(input.description, 'Description', { min: 10, max: 500 })!;
  const difficulty = parseDifficulty(input.difficulty);
  const proof_hint = str(input.proof_hint || 'Screenshot de fin de partie ou clip vidéo (15s)', 'Preuve attendue', { min: 5, max: 200 })!;
  const unlock_week = parseAct(input.unlock_week);
  const active = input.active === undefined ? 1 : input.active ? 1 : 0;
  const id = uniqueId(db, 'quests', `${game_id}_${difficulty}_${slugify(title).slice(0, 24)}`);

  db.prepare(
    `INSERT INTO quests (id, game_id, title, description, difficulty, points, proof_hint, unlock_week, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, game_id, title, description, difficulty, cfg.quest_points[difficulty], proof_hint, unlock_week, active);
  return db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as QuestRow;
}

export function updateQuest(db: Database.Database, id: string, input: QuestInput): QuestRow {
  const cfg = getEventConfig(db);
  const q = db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as QuestRow | undefined;
  if (!q) throw new Error('Défi introuvable.');

  const game_id = input.game_id !== undefined ? str(input.game_id, 'Jeu')! : q.game_id;
  if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(game_id)) throw new Error('Jeu introuvable.');
  const difficulty = input.difficulty !== undefined ? parseDifficulty(input.difficulty) : q.difficulty;

  if (difficulty !== q.difficulty || game_id !== q.game_id) {
    const validated = db
      .prepare(`SELECT COUNT(*) AS c FROM daily_assignments WHERE quest_id = ? AND status IN ('validated', 'submitted')`)
      .get(id) as { c: number };
    if (validated.c > 0) {
      throw new Error(
        'Ce défi a déjà été validé ou est en attente de validation : sa difficulté et son jeu ne peuvent plus changer. Archive-le et crée-en un nouveau.'
      );
    }
  }

  const next = {
    game_id,
    difficulty,
    points: cfg.quest_points[difficulty],
    title: input.title !== undefined ? str(input.title, 'Titre', { min: 3, max: 80 }) : q.title,
    description: input.description !== undefined ? str(input.description, 'Description', { min: 10, max: 500 }) : q.description,
    proof_hint: input.proof_hint !== undefined ? str(input.proof_hint, 'Preuve attendue', { min: 5, max: 200 }) : q.proof_hint,
    unlock_week: input.unlock_week !== undefined ? parseAct(input.unlock_week) : q.unlock_week,
    active: input.active !== undefined ? (input.active ? 1 : 0) : q.active,
  };

  db.prepare(
    `UPDATE quests SET game_id = @game_id, title = @title, description = @description, difficulty = @difficulty,
       points = @points, proof_hint = @proof_hint, unlock_week = @unlock_week, active = @active
     WHERE id = @id`
  ).run({ ...next, id });
  return db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as QuestRow;
}

export function deleteQuest(db: Database.Database, id: string): { deleted: true } {
  const q = db.prepare(`SELECT 1 FROM quests WHERE id = ?`).get(id);
  if (!q) throw new Error('Défi introuvable.');
  const used = db.prepare(`SELECT COUNT(*) AS c FROM daily_assignments WHERE quest_id = ?`).get(id) as { c: number };
  if (used.c > 0) {
    throw new Error(
      `Ce défi a déjà été tiré ${used.c} fois : le supprimer effacerait l’historique des joueurs. Archive-le plutôt (il ne sera plus tiré).`
    );
  }
  db.prepare(`DELETE FROM quests WHERE id = ?`).run(id);
  return { deleted: true };
}
