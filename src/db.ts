import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { seedDatabase } from './seed.js';

export interface DbContext {
  db: Database.Database;
  dataDir: string;
  proofsDir: string;
  replaysDir: string;
  logosDir: string;
}

let cachedContext: DbContext | null = null;

export function initDb(customDataDir?: string): DbContext {
  if (cachedContext && !customDataDir) {
    return cachedContext;
  }

  const dataDir = path.resolve(customDataDir || process.env.DATA_DIR || './data');
  const dbDir = path.join(dataDir, 'db');
  const proofsDir = path.join(dataDir, 'proofs');
  const replaysDir = path.join(dataDir, 'replays');
  const logosDir = path.join(dataDir, 'logos');

  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(proofsDir, { recursive: true });
  fs.mkdirSync(replaysDir, { recursive: true });
  fs.mkdirSync(logosDir, { recursive: true });

  const dbPath = path.join(dbDir, 'hgw.sqlite');
  const db = new Database(dbPath);

  // Décision D5 : SQLite en mode WAL pour haute concurrence lecture/écriture Web + Bot + Cron
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      tmnf_login TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      reroll_day_key TEXT,
      rerolls_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      platforms TEXT NOT NULL,
      is_universal INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_games (
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, game_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS quests (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
      points INTEGER NOT NULL,
      proof_hint TEXT NOT NULL DEFAULT 'Screenshot de fin de partie ou clip vidéo (15s)',
      unlock_week INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      quest_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'submitted', 'validated', 'rejected', 'expired', 'rerolled')),
      proof_type TEXT,
      proof_url TEXT,
      proof_file TEXT,
      proof_note TEXT,
      discord_message_id TEXT,
      reviewer_id TEXT,
      reject_reason TEXT,
      submitted_at TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_daily_user_day ON daily_assignments(user_id, day_key);
    CREATE INDEX IF NOT EXISTS idx_daily_user_week ON daily_assignments(user_id, week_key);
    CREATE INDEX IF NOT EXISTS idx_daily_status ON daily_assignments(status);

    CREATE TABLE IF NOT EXISTS tmnf_maps (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      uid TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL DEFAULT 'Stadium',
      is_weekly INTEGER NOT NULL DEFAULT 0,
      author_ms INTEGER NOT NULL,
      gold_ms INTEGER NOT NULL,
      silver_ms INTEGER NOT NULL,
      bronze_ms INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tmnf_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      map_id TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      medal TEXT NOT NULL CHECK (medal IN ('author', 'gold', 'silver', 'bronze', 'none')),
      points_awarded INTEGER NOT NULL DEFAULT 0,
      player_login TEXT NOT NULL,
      player_nickname TEXT,
      replay_sha256 TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (map_id) REFERENCES tmnf_maps(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tmnf_map_time ON tmnf_submissions(map_id, time_ms ASC);
    CREATE INDEX IF NOT EXISTS idx_tmnf_user_map ON tmnf_submissions(user_id, map_id);

    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      game_id TEXT NOT NULL,
      scheduled_label TEXT NOT NULL,
      scheduled_iso TEXT NOT NULL,
      mode_label TEXT NOT NULL,
      team_size INTEGER NOT NULL DEFAULT 1,
      is_major INTEGER NOT NULL DEFAULT 0,
      points_scale_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'checkin', 'live', 'completed')),
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tournament_registrations (
      tournament_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      pool INTEGER NOT NULL DEFAULT 2 CHECK (pool IN (1, 2, 3)),
      checked_in INTEGER NOT NULL DEFAULT 0,
      team_number INTEGER,
      team_name TEXT,
      placement INTEGER,
      fg_shows_json TEXT NOT NULL DEFAULT '[0,0,0,0,0]',
      fg_total_score INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tournament_id, user_id),
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('daily', 'tmnf_medal', 'tmnf_weekly', 'tournament', 'manual')),
      source_ref TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL CHECK (category IN ('async', 'live')),
      points INTEGER NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_cat ON points_ledger(category);

    CREATE TABLE IF NOT EXISTS event_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration douce si la base existait avant l'ajout de unlock_week (Format 2 Semaines)
  const questCols = db.prepare(`PRAGMA table_info(quests)`).all() as { name: string }[];
  if (!questCols.some((c) => c.name === 'unlock_week')) {
    db.exec(`ALTER TABLE quests ADD COLUMN unlock_week INTEGER NOT NULL DEFAULT 1`);
  }

  // Catalogue éditable depuis l'admin : logo et désactivation (sans suppression) d'un jeu
  const gameCols = db.prepare(`PRAGMA table_info(games)`).all() as { name: string }[];
  if (!gameCols.some((c) => c.name === 'logo_url')) {
    db.exec(`ALTER TABLE games ADD COLUMN logo_url TEXT`);
  }
  if (!gameCols.some((c) => c.name === 'active')) {
    db.exec(`ALTER TABLE games ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }

  seedDatabase(db);

  const ctx = { db, dataDir, proofsDir, replaysDir, logosDir };
  if (!customDataDir) {
    cachedContext = ctx;
  }
  return ctx;
}
