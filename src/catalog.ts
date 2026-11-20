import type Database from 'better-sqlite3';
import { QUEST_POINTS_BY_DIFFICULTY } from './seed.js';

// ============================================================================
// CATALOGUE JEUX & DÉFIS — CRUD du back-office
// ----------------------------------------------------------------------------
// Règles :
// - Les points d'un défi découlent de sa difficulté (10 / 15 / 25) pour garantir
//   les 50 pts/jour du tirage stratifié : ils ne sont pas saisissables.
// - Un défi déjà tiré à au moins un joueur ne peut pas être supprimé (cela
//   effacerait son historique et ses preuves par cascade) : on l'archive.
// - Même logique pour un jeu : suppression seulement s'il n'a jamais servi,
//   sinon désactivation (masqué des joueurs, exclu du tirage).
// ============================================================================

export type Difficulty = 'easy' | 'medium' | 'hard';
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
    .replace(/[̀-ͯ]/g, '')
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
// LECTURE
// ---------------------------------------------------------------------------

export function listCatalog(db: Database.Database) {
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
    .all();

  const quests = db
    .prepare(
      `SELECT q.*,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id) AS usage_count,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id AND da.status = 'validated') AS validated_count,
         (SELECT COUNT(*) FROM daily_assignments da WHERE da.quest_id = q.id AND da.status = 'rerolled') AS rerolled_count
       FROM quests q
       ORDER BY q.game_id ASC, CASE q.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC, q.unlock_week ASC, q.title ASC`
    )
    .all();

  return { games, quests, pointsByDifficulty: QUEST_POINTS_BY_DIFFICULTY };
}

// ---------------------------------------------------------------------------
// JEUX
// ---------------------------------------------------------------------------

export function createGame(db: Database.Database, input: GameInput): any {
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
  return db.prepare(`SELECT * FROM games WHERE id = ?`).get(id);
}

export function updateGame(db: Database.Database, id: string, input: GameInput): any {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as any;
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
  return db.prepare(`SELECT * FROM games WHERE id = ?`).get(id);
}

/** Supprime un jeu jamais utilisé. Retourne l'ancien logo pour permettre son nettoyage disque. */
export function deleteGame(db: Database.Database, id: string): { deleted: true; logo_url: string | null } {
  const game = db.prepare(`SELECT * FROM games WHERE id = ?`).get(id) as any;
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

  db.prepare(`DELETE FROM games WHERE id = ?`).run(id); // les défis jamais tirés partent en cascade
  return { deleted: true, logo_url: game.logo_url };
}

// ---------------------------------------------------------------------------
// DÉFIS
// ---------------------------------------------------------------------------

function parseDifficulty(v: unknown): Difficulty {
  if (!DIFFICULTIES.includes(v as Difficulty)) throw new Error('Difficulté invalide (facile, moyen ou difficile).');
  return v as Difficulty;
}

function parseWeek(v: unknown): number {
  const w = Number(v ?? 1);
  if (w !== 1 && w !== 2) throw new Error('L’acte doit valoir 1 ou 2.');
  return w;
}

export function createQuest(db: Database.Database, input: QuestInput): any {
  const game_id = str(input.game_id, 'Jeu')!;
  if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(game_id)) throw new Error('Jeu introuvable.');
  const title = str(input.title, 'Titre', { min: 3, max: 80 })!;
  const description = str(input.description, 'Description', { min: 10, max: 500 })!;
  const difficulty = parseDifficulty(input.difficulty);
  const proof_hint = str(input.proof_hint || 'Screenshot de fin de partie ou clip vidéo (15s)', 'Preuve attendue', { min: 5, max: 200 })!;
  const unlock_week = parseWeek(input.unlock_week);
  const active = input.active === undefined ? 1 : input.active ? 1 : 0;
  const id = uniqueId(db, 'quests', `${game_id}_${difficulty}_${slugify(title).slice(0, 24)}`);

  db.prepare(
    `INSERT INTO quests (id, game_id, title, description, difficulty, points, proof_hint, unlock_week, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, game_id, title, description, difficulty, QUEST_POINTS_BY_DIFFICULTY[difficulty], proof_hint, unlock_week, active);
  return db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id);
}

export function updateQuest(db: Database.Database, id: string, input: QuestInput): any {
  const q = db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as any;
  if (!q) throw new Error('Défi introuvable.');

  const game_id = input.game_id !== undefined ? str(input.game_id, 'Jeu')! : q.game_id;
  if (!db.prepare(`SELECT 1 FROM games WHERE id = ?`).get(game_id)) throw new Error('Jeu introuvable.');
  const difficulty = input.difficulty !== undefined ? parseDifficulty(input.difficulty) : (q.difficulty as Difficulty);

  // Changer la difficulté d'un défi déjà validé modifierait rétroactivement le barème : on l'interdit.
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
    points: QUEST_POINTS_BY_DIFFICULTY[difficulty],
    title: input.title !== undefined ? str(input.title, 'Titre', { min: 3, max: 80 }) : q.title,
    description: input.description !== undefined ? str(input.description, 'Description', { min: 10, max: 500 }) : q.description,
    proof_hint: input.proof_hint !== undefined ? str(input.proof_hint, 'Preuve attendue', { min: 5, max: 200 }) : q.proof_hint,
    unlock_week: input.unlock_week !== undefined ? parseWeek(input.unlock_week) : q.unlock_week,
    active: input.active !== undefined ? (input.active ? 1 : 0) : q.active,
  };

  db.prepare(
    `UPDATE quests SET game_id = @game_id, title = @title, description = @description, difficulty = @difficulty,
       points = @points, proof_hint = @proof_hint, unlock_week = @unlock_week, active = @active
     WHERE id = @id`
  ).run({ ...next, id });
  return db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id);
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
