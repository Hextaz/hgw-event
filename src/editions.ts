import type Database from 'better-sqlite3';
import { getEventConfig, updateEventConfig } from './config.js';
import { listFeaturedItems, recalculateFeaturedLadder } from './featured.js';
import { listTournamentsWithRegistrations } from './tournaments.js';
import { slugify } from './catalog.js';

// ============================================================================
// CYCLE DE VIE DES ÉDITIONS & HALL OF FAME (editions_archive)
// ============================================================================

export interface EditionSnapshot {
  event_name: string;
  event_subtitle: string;
  prizes: string[];
  tombola_prize: string;
  tombola_threshold: number;
  acts_count: number;
  started_at: string;
  ended_at: string;
  podium: any[];
  leaderboard: any[];
  tombola_winner: { id: string; display_name: string; total_points: number } | null;
  tournaments: {
    id: string;
    name: string;
    emoji: string;
    team_size: number;
    scoring_mode: string;
    top_players: { user_id: string; display_name: string; placement: number | null; points_awarded: number; team_name: string | null }[];
  }[];
  featured: {
    enabled: boolean;
    title: string;
    ladder_title: string;
    ladder_top: any[];
    stages_count: number;
  };
  stats: {
    total_users: number;
    total_quests_validated: number;
    total_points: number;
    tombola_qualified: number;
  };
}

export function listArchivedEditions(db: Database.Database) {
  const rows = db
    .prepare(`SELECT * FROM editions_archive ORDER BY archived_at DESC, rowid DESC`)
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    subtitle: r.subtitle,
    started_at: r.started_at,
    ended_at: r.ended_at,
    archived_at: r.archived_at,
    snapshot: JSON.parse(r.snapshot_json) as EditionSnapshot,
  }));
}

export function deleteArchivedEdition(db: Database.Database, id: string): { deleted: true } {
  const res = db.prepare(`DELETE FROM editions_archive WHERE id = ?`).run(id);
  if (res.changes === 0) throw new Error('Archive introuvable.');
  return { deleted: true };
}

/**
 * Construit le snapshot complet de l'édition active et l'enregistre dans le Hall of Fame.
 */
export function archiveCurrentEdition(
  db: Database.Database,
  opts: {
    leaderboard: any[];
    customName?: string;
    tombolaWinner?: { id: string; display_name: string; total_points: number } | null;
  }
) {
  const cfg = getEventConfig(db);
  const name = String(opts.customName || cfg.event_name).trim() || cfg.event_name;
  const tournaments = listTournamentsWithRegistrations(db, true);
  const ladder = recalculateFeaturedLadder(db);
  const items = listFeaturedItems(db, false);

  const totalQuests = (
    db.prepare(`SELECT COUNT(*) AS c FROM daily_assignments WHERE status = 'validated'`).get() as { c: number }
  ).c;
  const totalPoints = (
    db.prepare(`SELECT COALESCE(SUM(points), 0) AS s FROM points_ledger`).get() as { s: number }
  ).s;

  // Récupérer le dernier gagnant tombola stocké si non fourni explicitement
  let tombolaWinner = opts.tombolaWinner ?? null;
  if (!tombolaWinner) {
    const saved = db.prepare(`SELECT value FROM event_settings WHERE key = 'last_tombola_winner_json'`).get() as
      | { value: string }
      | undefined;
    if (saved?.value) {
      try {
        tombolaWinner = JSON.parse(saved.value);
      } catch {
        tombolaWinner = null;
      }
    }
  }

  const lbCompact = opts.leaderboard.map((p) => ({
    rank: p.rank,
    id: p.id,
    display_name: p.display_name,
    avatar: p.avatar || null,
    total_points: p.total_points,
    async_points: p.async_points,
    live_points: p.live_points,
    quests_validated: p.quests_validated,
    tombola_eligible: p.tombola_eligible,
  }));

  const snapshot: EditionSnapshot = {
    event_name: name,
    event_subtitle: cfg.event_subtitle,
    prizes: cfg.prizes,
    tombola_prize: cfg.tombola_prize,
    tombola_threshold: cfg.tombola_threshold,
    acts_count: cfg.acts_count,
    started_at: cfg.start_at,
    ended_at: cfg.end_at,
    podium: lbCompact.slice(0, 3),
    leaderboard: lbCompact,
    tombola_winner: tombolaWinner,
    tournaments: tournaments.map((t) => ({
      id: t.id,
      name: t.name,
      emoji: t.emoji,
      team_size: t.team_size,
      scoring_mode: t.scoring_mode,
      top_players: t.registrations
        .filter((r: any) => r.placement || r.points_awarded > 0)
        .sort((a: any, b: any) => (a.placement || 999) - (b.placement || 999))
        .slice(0, 12)
        .map((r: any) => ({
          user_id: r.user_id,
          display_name: r.display_name,
          placement: r.placement ?? null,
          points_awarded: r.points_awarded || 0,
          team_name: r.team_name || null,
        })),
    })),
    featured: {
      enabled: cfg.featured.enabled,
      title: cfg.featured.title,
      ladder_title: cfg.featured.ladder_title,
      ladder_top: ladder.slice(0, 10),
      stages_count: items.filter((i) => !i.is_ladder).length,
    },
    stats: {
      total_users: opts.leaderboard.length,
      total_quests_validated: totalQuests,
      total_points: totalPoints,
      tombola_qualified: opts.leaderboard.filter((p) => p.tombola_eligible).length,
    },
  };

  const baseId = slugify(name) || 'edition';
  const id = `${baseId}_${Date.now()}`;

  db.prepare(
    `INSERT INTO editions_archive (id, name, subtitle, started_at, ended_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, cfg.event_subtitle, cfg.start_at, cfg.end_at, JSON.stringify(snapshot));

  return { id, name, snapshot };
}

/**
 * Démarre une nouvelle édition proprement :
 * 1. Archive l'édition actuelle dans le Hall of Fame (si `archiveCurrent !== false` et qu'il y a eu des points).
 * 2. Remet à zéro les données de session (ledger, défis tirés, jeux cochés par les joueurs, inscriptions tournois, soumissions jeu vedette).
 * 3. Conserve intacts les comptes Discord (`users`), toute la bibliothèque `games` & `quests`, et le Hall of Fame.
 * 4. Optionnellement conserve ou vide la liste des tournois et des épreuves vedettes.
 * 5. Passe l'édition en mode `draft` (Préparation) avec son nouveau nom.
 */
export function startNewEdition(
  db: Database.Database,
  params: {
    newName: string;
    leaderboard: any[];
    archiveCurrent?: boolean;
    keepTournaments?: boolean;
    keepFeaturedItems?: boolean;
  }
) {
  const newName = String(params.newName || '').trim();
  if (newName.length < 3 || newName.length > 100) {
    throw new Error('Le nom de la nouvelle édition doit faire entre 3 et 100 caractères.');
  }

  let archived: { id: string; name: string } | null = null;
  const hasActivity =
    (db.prepare(`SELECT COUNT(*) AS c FROM points_ledger`).get() as { c: number }).c > 0 ||
    (db.prepare(`SELECT COUNT(*) AS c FROM daily_assignments`).get() as { c: number }).c > 0;

  const tx = db.transaction(() => {
    if (params.archiveCurrent !== false && hasActivity) {
      const a = archiveCurrentEdition(db, { leaderboard: params.leaderboard });
      archived = { id: a.id, name: a.name };
    }

    // Remise à zéro des données de la session uniquement
    db.prepare(`DELETE FROM points_ledger`).run();
    db.prepare(`DELETE FROM daily_assignments`).run();
    db.prepare(`DELETE FROM user_games`).run();
    db.prepare(`DELETE FROM featured_submissions`).run();
    db.prepare(`DELETE FROM tournament_registrations`).run();
    db.prepare(`UPDATE users SET reroll_day_key = NULL, rerolls_used = 0`).run();
    db.prepare(`DELETE FROM event_settings WHERE key = 'last_tombola_winner_json'`).run();

    if (params.keepTournaments === false) {
      db.prepare(`DELETE FROM tournaments`).run();
    } else {
      db.prepare(`UPDATE tournaments SET status = 'upcoming'`).run();
    }

    if (params.keepFeaturedItems === false) {
      db.prepare(`DELETE FROM featured_items`).run();
    }
  });
  tx();

  const updatedConfig = updateEventConfig(db, {
    event_name: newName,
    status_mode: 'draft',
  });

  return {
    archived,
    eventConfig: updatedConfig,
  };
}
