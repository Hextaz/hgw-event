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

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

/**
 * Migre `points_ledger` si l'ancienne contrainte CHECK n'autorise pas encore `featured_stage` / `featured_ladder`.
 */
function migratePointsLedgerConstraint(db: Database.Database): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'points_ledger'`)
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes('featured_stage')) return;

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE points_ledger_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK (source_type IN ('daily', 'tmnf_medal', 'tmnf_weekly', 'featured_stage', 'featured_ladder', 'tournament', 'manual')),
          source_ref TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL CHECK (category IN ('async', 'live')),
          points INTEGER NOT NULL,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        INSERT INTO points_ledger_new (id, user_id, source_type, source_ref, category, points, label, created_at, updated_at)
        SELECT id, user_id, source_type, source_ref, category, points, label, created_at, updated_at FROM points_ledger;
        DROP TABLE points_ledger;
        ALTER TABLE points_ledger_new RENAME TO points_ledger;
        CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_cat ON points_ledger(category);
      `);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/**
 * Migre les anciennes tables `tmnf_maps` / `tmnf_submissions` vers `featured_items` / `featured_submissions`
 * si `featured_items` est encore vide (mise à jour transparente d'une base existante).
 */
function migrateLegacyTmnfToFeatured(db: Database.Database): void {
  const existingFeatured = (db.prepare(`SELECT COUNT(*) AS c FROM featured_items`).get() as { c: number }).c;
  if (existingFeatured > 0) return;

  const hasLegacyMaps = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tmnf_maps'`)
    .get();
  if (!hasLegacyMaps) return;

  const legacyMaps = db.prepare(`SELECT * FROM tmnf_maps ORDER BY sort_order ASC`).all() as any[];
  if (legacyMaps.length === 0) return;

  const tx = db.transaction(() => {
    const insItem = db.prepare(`
      INSERT OR IGNORE INTO featured_items (
        id, code, name, description, is_ladder, external_uid, thresholds_json, metadata_json, active, sort_order
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, ?)
    `);
    for (const m of legacyMaps) {
      const thresholds = {
        author: m.author_ms,
        gold: m.gold_ms,
        silver: m.silver_ms,
        bronze: m.bronze_ms,
      };
      const meta = { environment: m.environment || 'Stadium' };
      insItem.run(m.id, m.code, m.name, m.is_weekly ? 1 : 0, m.uid, JSON.stringify(thresholds), JSON.stringify(meta), m.sort_order || 0);
    }

    const hasLegacySubs = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tmnf_submissions'`)
      .get();
    if (hasLegacySubs) {
      const legacySubs = db.prepare(`SELECT * FROM tmnf_submissions ORDER BY id ASC`).all() as any[];
      const insSub = db.prepare(`
        INSERT OR IGNORE INTO featured_submissions (
          user_id, item_id, metric_value, tier_key, points_awarded, status,
          proof_type, external_hash, external_login, external_nickname, file_name, created_at, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, 'validated', 'gbx', ?, ?, ?, ?, ?, ?)
      `);
      for (const s of legacySubs) {
        insSub.run(
          s.user_id,
          s.map_id,
          s.time_ms,
          s.medal,
          s.points_awarded,
          s.replay_sha256,
          s.player_login,
          s.player_nickname,
          s.file_name,
          s.created_at,
          s.created_at
        );
      }
    }

    db.prepare(`INSERT OR IGNORE INTO event_settings (key, value) VALUES ('featured_seeded', datetime('now'))`).run();
  });
  tx();
}

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
      sort_order INTEGER NOT NULL DEFAULT 0,
      logo_url TEXT,
      active INTEGER NOT NULL DEFAULT 1
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

    -- Jeu Vedette Modulaire (épreuves à paliers + ladder ouvert, compatible Trackmania GBX et tout jeu standard)
    CREATE TABLE IF NOT EXISTS featured_items (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_ladder INTEGER NOT NULL DEFAULT 0,
      external_uid TEXT,
      thresholds_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_featured_items_uid ON featured_items(external_uid);

    CREATE TABLE IF NOT EXISTS featured_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      metric_value REAL NOT NULL DEFAULT 0,
      tier_key TEXT NOT NULL DEFAULT 'none',
      points_awarded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'validated' CHECK (status IN ('pending', 'validated', 'rejected')),
      proof_type TEXT,
      proof_url TEXT,
      proof_file TEXT,
      proof_note TEXT,
      external_hash TEXT UNIQUE,
      external_login TEXT,
      external_nickname TEXT,
      file_name TEXT,
      discord_message_id TEXT,
      reviewer_id TEXT,
      reject_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES featured_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_feat_sub_item_val ON featured_submissions(item_id, status, metric_value);
    CREATE INDEX IF NOT EXISTS idx_feat_sub_user_item ON featured_submissions(user_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_feat_sub_status ON featured_submissions(status);

    CREATE TABLE IF NOT EXISTS tournaments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🏆',
      game_id TEXT NOT NULL DEFAULT '',
      scheduled_label TEXT NOT NULL DEFAULT '',
      scheduled_iso TEXT NOT NULL DEFAULT '',
      mode_label TEXT NOT NULL DEFAULT '',
      team_size INTEGER NOT NULL DEFAULT 1,
      is_major INTEGER NOT NULL DEFAULT 0,
      scoring_mode TEXT NOT NULL DEFAULT 'direct' CHECK (scoring_mode IN ('direct', 'rounds')),
      rounds_count INTEGER NOT NULL DEFAULT 5,
      round_presets_json TEXT NOT NULL DEFAULT '[]',
      bracket_url TEXT,
      points_scale_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'checkin', 'live', 'completed')),
      active INTEGER NOT NULL DEFAULT 1,
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
      round_scores_json TEXT NOT NULL DEFAULT '[]',
      round_total_score INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tournament_id, user_id),
      FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('daily', 'tmnf_medal', 'tmnf_weekly', 'featured_stage', 'featured_ladder', 'tournament', 'manual')),
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

    CREATE TABLE IF NOT EXISTS editions_archive (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      snapshot_json TEXT NOT NULL
    );
  `);

  // Migrations douces pour bases existantes
  if (!hasColumn(db, 'quests', 'unlock_week')) {
    db.exec(`ALTER TABLE quests ADD COLUMN unlock_week INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn(db, 'games', 'logo_url')) {
    db.exec(`ALTER TABLE games ADD COLUMN logo_url TEXT`);
  }
  if (!hasColumn(db, 'games', 'active')) {
    db.exec(`ALTER TABLE games ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn(db, 'tournaments', 'scoring_mode')) {
    db.exec(`ALTER TABLE tournaments ADD COLUMN scoring_mode TEXT NOT NULL DEFAULT 'direct'`);
    db.prepare(`UPDATE tournaments SET scoring_mode = 'rounds' WHERE id = 'fall_guys'`).run();
  }
  if (!hasColumn(db, 'tournaments', 'rounds_count')) {
    db.exec(`ALTER TABLE tournaments ADD COLUMN rounds_count INTEGER NOT NULL DEFAULT 5`);
  }
  if (!hasColumn(db, 'tournaments', 'round_presets_json')) {
    db.exec(`ALTER TABLE tournaments ADD COLUMN round_presets_json TEXT NOT NULL DEFAULT '[]'`);
    const fgPresets = JSON.stringify([
      { label: 'Éliminé', points: 1 },
      { label: 'Qualifié', points: 3 },
      { label: 'Finale', points: 6 },
      { label: 'Couronne', points: 10 },
    ]);
    db.prepare(`UPDATE tournaments SET round_presets_json = ? WHERE id = 'fall_guys'`).run(fgPresets);
  }
  if (!hasColumn(db, 'tournaments', 'bracket_url')) {
    db.exec(`ALTER TABLE tournaments ADD COLUMN bracket_url TEXT`);
  }
  if (!hasColumn(db, 'tournaments', 'active')) {
    db.exec(`ALTER TABLE tournaments ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn(db, 'tournament_registrations', 'round_scores_json')) {
    db.exec(`ALTER TABLE tournament_registrations ADD COLUMN round_scores_json TEXT NOT NULL DEFAULT '[]'`);
    db.exec(`UPDATE tournament_registrations SET round_scores_json = fg_shows_json WHERE fg_shows_json IS NOT NULL AND fg_shows_json != ''`);
  }
  if (!hasColumn(db, 'tournament_registrations', 'round_total_score')) {
    db.exec(`ALTER TABLE tournament_registrations ADD COLUMN round_total_score INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE tournament_registrations SET round_total_score = fg_total_score WHERE fg_total_score IS NOT NULL`);
  }

  migratePointsLedgerConstraint(db);
  migrateLegacyTmnfToFeatured(db);

  seedDatabase(db);

  const ctx = { db, dataDir, proofsDir, replaysDir, logosDir };
  if (!customDataDir) {
    cachedContext = ctx;
  }
  return ctx;
}
