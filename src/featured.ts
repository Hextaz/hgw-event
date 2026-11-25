import type Database from 'better-sqlite3';
import { getEventConfig, type FeaturedConfig, type FeaturedTier, type MetricType } from './config.js';
import { formatTmTime, parseReplayGbx } from './gbx.js';
import { slugify } from './catalog.js';

// ============================================================================
// JEU VEDETTE MODULAIRE (0 ou 1 jeu par édition)
// ----------------------------------------------------------------------------
// Supporte 2 connecteurs :
// - 'standard' : preuve (capture/clip/lien) + valeur optionnelle -> modération
//   unifiée (#preuves Discord + back-office Admin), compatible tout genre de jeu.
// - 'tmnf_gbx' : validation automatique .Replay.gbx + webhook XML-RPC + ghosts.
// ============================================================================

export interface FeaturedItemInput {
  id?: string;
  code?: string;
  name?: string;
  description?: string;
  is_ladder?: boolean | number;
  external_uid?: string | null;
  thresholds?: Record<string, number>;
  metadata?: Record<string, unknown>;
  active?: boolean | number;
  sort_order?: number;
}

export function formatMetricValue(value: number, metricType: MetricType, unit = ''): string {
  if (!Number.isFinite(value)) return '—';
  if (metricType === 'time_asc') return formatTmTime(value);
  if (metricType === 'binary') return value > 0 ? 'Validé' : '—';
  const formatted = Math.round(value).toLocaleString('fr-FR');
  return unit ? `${formatted} ${unit}` : formatted;
}

/**
 * Détermine le meilleur palier atteint pour une valeur donnée selon la config du jeu vedette.
 */
export function evaluateFeaturedTier(
  value: number,
  thresholds: Record<string, number>,
  tiers: FeaturedTier[],
  metricType: MetricType
): { tierKey: string; tierLabel: string; points: number } {
  const sorted = [...tiers].sort((a, b) => b.points - a.points);
  if (metricType === 'binary') {
    if (value > 0 && sorted.length > 0) {
      const t = sorted[0];
      return { tierKey: t.key, tierLabel: t.label, points: t.points };
    }
    return { tierKey: 'none', tierLabel: 'Aucun', points: 0 };
  }

  for (const tier of sorted) {
    const threshold = thresholds[tier.key];
    if (threshold === undefined || !Number.isFinite(Number(threshold))) continue;
    const hit = metricType === 'time_asc' ? value <= Number(threshold) : value >= Number(threshold);
    if (hit) {
      return { tierKey: tier.key, tierLabel: tier.label, points: tier.points };
    }
  }
  return { tierKey: 'none', tierLabel: 'Aucun', points: 0 };
}

function uniqueFeaturedItemId(db: Database.Database, base: string): string {
  let id = base || `feat_${Date.now()}`;
  let i = 2;
  const exists = db.prepare(`SELECT 1 FROM featured_items WHERE id = ?`);
  while (exists.get(id)) id = `${base}_${i++}`;
  return id;
}

export function hydrateFeaturedItem(row: any, cfg: FeaturedConfig) {
  let thresholds: Record<string, number> = {};
  let metadata: Record<string, any> = {};
  try {
    thresholds = JSON.parse(row.thresholds_json || '{}');
  } catch {
    thresholds = {};
  }
  try {
    metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    metadata = {};
  }

  const authorMs = thresholds.author ?? 0;
  const goldMs = thresholds.gold ?? 0;
  const silverMs = thresholds.silver ?? 0;
  const bronzeMs = thresholds.bronze ?? 0;

  return {
    ...row,
    thresholds,
    metadata,
    // Compatibilité TMNF pour l'UI existante et les tests
    uid: row.external_uid || '',
    is_weekly: row.is_ladder ? 1 : 0,
    environment: metadata.environment || 'Stadium',
    author_ms: authorMs,
    gold_ms: goldMs,
    silver_ms: silverMs,
    bronze_ms: bronzeMs,
    author_formatted: authorMs ? formatTmTime(authorMs) : '—',
    gold_formatted: goldMs ? formatTmTime(goldMs) : '—',
    silver_formatted: silverMs ? formatTmTime(silverMs) : '—',
    bronze_formatted: bronzeMs ? formatTmTime(bronzeMs) : '—',
    thresholds_formatted: Object.fromEntries(
      Object.entries(thresholds).map(([k, v]) => [k, formatMetricValue(Number(v), cfg.metric_type, cfg.metric_unit)])
    ),
  };
}

// ---------------------------------------------------------------------------
// CRUD ADMIN DES ÉPREUVES DU JEU VEDETTE
// ---------------------------------------------------------------------------

export function listFeaturedItems(db: Database.Database, includeInactive = false) {
  const cfg = getEventConfig(db).featured;
  const rows = db
    .prepare(
      includeInactive
        ? `SELECT fi.*,
             (SELECT COUNT(*) FROM featured_submissions fs WHERE fs.item_id = fi.id) AS submission_count
           FROM featured_items fi
           ORDER BY fi.is_ladder DESC, fi.sort_order ASC, fi.name ASC`
        : `SELECT fi.*,
             (SELECT COUNT(*) FROM featured_submissions fs WHERE fs.item_id = fi.id) AS submission_count
           FROM featured_items fi
           WHERE fi.active = 1
           ORDER BY fi.is_ladder DESC, fi.sort_order ASC, fi.name ASC`
    )
    .all() as any[];

  const orderSql = cfg.metric_type === 'time_asc' ? 'MIN(f2.metric_value)' : 'MAX(f2.metric_value)';
  const wrRows = db
    .prepare(
      `SELECT fs.item_id, fs.metric_value, u.display_name
       FROM featured_submissions fs
       JOIN users u ON u.id = fs.user_id
       WHERE fs.status = 'validated'
         AND fs.metric_value = (
           SELECT ${orderSql} FROM featured_submissions f2
           WHERE f2.item_id = fs.item_id AND f2.status = 'validated'
         )
       GROUP BY fs.item_id`
    )
    .all() as { item_id: string; metric_value: number; display_name: string }[];
  const wrMap = new Map(wrRows.map((r) => [r.item_id, r]));

  return rows.map((row) => {
    const h = hydrateFeaturedItem(row, cfg);
    const wr = wrMap.get(row.id);
    return {
      ...h,
      wr_value: wr ? wr.metric_value : null,
      wr_time_ms: wr ? wr.metric_value : null,
      wr_formatted: wr ? formatMetricValue(wr.metric_value, cfg.metric_type, cfg.metric_unit) : null,
      wr_holder: wr ? wr.display_name : null,
    };
  });
}

function normalizeThresholds(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(k).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const n = Number(v);
    if (key && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

export function createFeaturedItem(db: Database.Database, input: FeaturedItemInput) {
  const cfg = getEventConfig(db).featured;
  const code = String(input.code || '').trim().slice(0, 40);
  const name = String(input.name || '').trim().slice(0, 100);
  if (name.length < 2) throw new Error('Le nom de l’épreuve doit contenir au moins 2 caractères.');
  const finalCode = code || slugify(name).toUpperCase().slice(0, 16) || 'EPREUVE';
  const description = String(input.description || '').trim().slice(0, 400);
  const isLadder = input.is_ladder ? 1 : 0;
  const externalUid = input.external_uid ? String(input.external_uid).trim().slice(0, 120) : null;
  const thresholds = normalizeThresholds(input.thresholds);
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const active = input.active === undefined ? 1 : input.active ? 1 : 0;

  if (externalUid) {
    const dup = db.prepare(`SELECT id, name FROM featured_items WHERE external_uid = ?`).get(externalUid) as any;
    if (dup) throw new Error(`Cet UID (${externalUid}) est déjà utilisé par « ${dup.name} ».`);
  }

  const maxOrder = (
    db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM featured_items WHERE is_ladder = ?`).get(isLadder) as { m: number }
  ).m;
  const sortOrder =
    input.sort_order !== undefined && Number.isFinite(Number(input.sort_order))
      ? Math.trunc(Number(input.sort_order))
      : isLadder
      ? 0
      : maxOrder + 1;

  const id = uniqueFeaturedItemId(db, slugify(input.id || `${isLadder ? 'ladder' : 'stage'}_${finalCode}`));

  const tx = db.transaction(() => {
    // Une seule épreuve Ladder active à la fois pour garder un Top N clair
    if (isLadder && active) {
      db.prepare(`UPDATE featured_items SET is_ladder = 0 WHERE is_ladder = 1`).run();
    }
    db.prepare(
      `INSERT INTO featured_items (
        id, code, name, description, is_ladder, external_uid, thresholds_json, metadata_json, active, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, finalCode, name, description, isLadder, externalUid, JSON.stringify(thresholds), JSON.stringify(metadata), active, sortOrder);
  });
  tx();

  return hydrateFeaturedItem(db.prepare(`SELECT * FROM featured_items WHERE id = ?`).get(id), cfg);
}

export function updateFeaturedItem(db: Database.Database, id: string, input: FeaturedItemInput) {
  const cfg = getEventConfig(db).featured;
  const existing = db.prepare(`SELECT * FROM featured_items WHERE id = ?`).get(id) as any;
  if (!existing) throw new Error('Épreuve introuvable.');

  const name = input.name !== undefined ? String(input.name).trim().slice(0, 100) : existing.name;
  if (name.length < 2) throw new Error('Le nom de l’épreuve doit contenir au moins 2 caractères.');
  const code = input.code !== undefined ? String(input.code).trim().slice(0, 40) || existing.code : existing.code;
  const description = input.description !== undefined ? String(input.description).trim().slice(0, 400) : existing.description;
  const isLadder = input.is_ladder !== undefined ? (input.is_ladder ? 1 : 0) : existing.is_ladder;
  const externalUid =
    input.external_uid !== undefined
      ? input.external_uid
        ? String(input.external_uid).trim().slice(0, 120)
        : null
      : existing.external_uid;
  const active = input.active !== undefined ? (input.active ? 1 : 0) : existing.active;
  const sortOrder =
    input.sort_order !== undefined && Number.isFinite(Number(input.sort_order))
      ? Math.trunc(Number(input.sort_order))
      : existing.sort_order;
  const thresholdsJson =
    input.thresholds !== undefined ? JSON.stringify(normalizeThresholds(input.thresholds)) : existing.thresholds_json;
  const metadataJson =
    input.metadata !== undefined && typeof input.metadata === 'object'
      ? JSON.stringify(input.metadata)
      : existing.metadata_json;

  if (externalUid) {
    const dup = db
      .prepare(`SELECT id, name FROM featured_items WHERE external_uid = ? AND id != ?`)
      .get(externalUid, id) as any;
    if (dup) throw new Error(`Cet UID (${externalUid}) est déjà utilisé par « ${dup.name} ».`);
  }

  const tx = db.transaction(() => {
    if (isLadder && active) {
      db.prepare(`UPDATE featured_items SET is_ladder = 0 WHERE is_ladder = 1 AND id != ?`).run(id);
    }
    db.prepare(
      `UPDATE featured_items SET
        code = ?, name = ?, description = ?, is_ladder = ?, external_uid = ?,
        thresholds_json = ?, metadata_json = ?, active = ?, sort_order = ?
       WHERE id = ?`
    ).run(code, name, description, isLadder, externalUid, thresholdsJson, metadataJson, active, sortOrder, id);
  });
  tx();

  return hydrateFeaturedItem(db.prepare(`SELECT * FROM featured_items WHERE id = ?`).get(id), cfg);
}

export function deleteFeaturedItem(db: Database.Database, id: string): { deleted: true } {
  const existing = db.prepare(`SELECT * FROM featured_items WHERE id = ?`).get(id);
  if (!existing) throw new Error('Épreuve introuvable.');
  const used = (
    db.prepare(`SELECT COUNT(*) AS c FROM featured_submissions WHERE item_id = ?`).get(id) as { c: number }
  ).c;
  if (used > 0) {
    throw new Error(`Cette épreuve a déjà ${used} soumission(s). Désactive-la plutôt pour conserver l’historique.`);
  }
  db.prepare(`DELETE FROM featured_items WHERE id = ?`).run(id);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// RECALCUL DU LADDER & DU LEDGER POUR LES PALIERS
// ---------------------------------------------------------------------------

export function recalculateFeaturedLadder(db: Database.Database): any[] {
  const fullCfg = getEventConfig(db);
  const cfg = fullCfg.featured;
  const ladderItem = db.prepare(`SELECT * FROM featured_items WHERE is_ladder = 1 AND active = 1 LIMIT 1`).get() as any;
  if (!ladderItem || !cfg.enabled || !cfg.ladder_enabled) {
    return [];
  }

  const aggFn = cfg.metric_type === 'time_asc' ? 'MIN(s.metric_value)' : 'MAX(s.metric_value)';
  const orderDir = cfg.metric_type === 'time_asc' ? 'ASC' : 'DESC';

  const bestRuns = db
    .prepare(
      `SELECT s.user_id, u.display_name, u.avatar, ${aggFn} AS best_value,
              COALESCE(MAX(s.external_login), u.tmnf_login, u.username) AS player_login
       FROM featured_submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.item_id = ? AND s.status = 'validated'
       GROUP BY s.user_id
       ORDER BY best_value ${orderDir}, MIN(s.id) ASC`
    )
    .all(ladderItem.id) as {
    user_id: string;
    display_name: string;
    avatar: string | null;
    best_value: number;
    player_login: string;
  }[];

  const scale = cfg.ladder_points_scale;

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM points_ledger WHERE source_type IN ('tmnf_weekly', 'featured_ladder')`).run();
    const ins = db.prepare(`
      INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label)
      VALUES (?, 'featured_ladder', ?, 'async', ?, ?)
    `);
    bestRuns.forEach((run, idx) => {
      const rank = idx + 1;
      const pts = rank <= scale.length ? scale[rank - 1] : 0;
      if (pts > 0) {
        const formatted = formatMetricValue(run.best_value, cfg.metric_type, cfg.metric_unit);
        ins.run(
          run.user_id,
          `featured_ladder:${run.user_id}`,
          pts,
          `⏱️ ${cfg.title} ${cfg.ladder_title} — #${rank} (${formatted})`
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
    best_value: r.best_value,
    best_time_ms: r.best_value,
    formatted_value: formatMetricValue(r.best_value, cfg.metric_type, cfg.metric_unit),
    formatted_time: formatMetricValue(r.best_value, cfg.metric_type, cfg.metric_unit),
    player_login: r.player_login,
    projected_points: i < scale.length ? scale[i] : 0,
  }));
}

function syncUserStageLedger(db: Database.Database, userId: string, item: any, cfg: FeaturedConfig): void {
  const aggFn = cfg.metric_type === 'time_asc' ? 'MIN(metric_value)' : 'MAX(metric_value)';
  const row = db
    .prepare(
      `SELECT ${aggFn} AS best_val, MAX(points_awarded) AS max_pts
       FROM featured_submissions
       WHERE user_id = ? AND item_id = ? AND status = 'validated'`
    )
    .get(userId, item.id) as { best_val: number | null; max_pts: number | null };

  const sourceRef = `featured_stage:${userId}:${item.id}`;
  const legacyRef = `tmnf_medal:${userId}:${item.id}`;
  // Nettoyage de l'éventuelle ancienne clé legacy pour éviter tout double comptage
  db.prepare(`DELETE FROM points_ledger WHERE source_ref = ?`).run(legacyRef);

  const pts = row?.max_pts || 0;
  if (pts <= 0 || row?.best_val === null) {
    db.prepare(`DELETE FROM points_ledger WHERE source_ref = ?`).run(sourceRef);
    return;
  }

  const thresholds = JSON.parse(item.thresholds_json || '{}');
  const evalRes = evaluateFeaturedTier(row.best_val, thresholds, cfg.tiers, cfg.metric_type);
  const valStr = formatMetricValue(row.best_val, cfg.metric_type, cfg.metric_unit);
  const label =
    cfg.metric_type === 'binary'
      ? `🏅 ${cfg.title} ${item.code} — ${item.name} (+${pts} pts)`
      : `🏅 ${cfg.title} ${item.code} — ${evalRes.tierLabel} (${valStr})`;

  db.prepare(
    `INSERT INTO points_ledger (user_id, source_type, source_ref, category, points, label, updated_at)
     VALUES (?, 'featured_stage', ?, 'async', ?, ?, datetime('now'))
     ON CONFLICT(source_ref) DO UPDATE SET
       points = excluded.points,
       label = excluded.label,
       updated_at = datetime('now')`
  ).run(userId, sourceRef, pts, label);
}

// ---------------------------------------------------------------------------
// CONNECTEUR STANDARD (Preuve image/clip/lien + modération unifiée)
// ---------------------------------------------------------------------------

export function submitFeaturedStandard(
  db: Database.Database,
  params: {
    userId: string;
    itemId: string;
    metricValue?: number;
    proofUrl?: string;
    proofFile?: string;
    proofNote?: string;
  }
): any {
  const lifecycle = getEventConfig(db);
  const cfg = lifecycle.featured;
  if (!cfg.enabled) throw new Error('Le jeu vedette n’est pas activé sur cette édition.');
  if (lifecycle.effective_phase === 'closed' || lifecycle.effective_phase === 'draft') {
    throw new Error('Les soumissions sont fermées pour le moment.');
  }

  const item = db.prepare(`SELECT * FROM featured_items WHERE id = ? AND active = 1`).get(params.itemId) as any;
  if (!item) throw new Error('Épreuve introuvable ou inactive.');

  if (item.is_ladder) {
    if (!lifecycle.ladder_unlocked) {
      throw new Error(
        lifecycle.ladder_locked
          ? `Le ${cfg.ladder_title} est clôturé.`
          : `🔒 Le ${cfg.ladder_title} se débloque à l’Acte ${cfg.ladder_unlock_act}.`
      );
    }
  }

  if (!params.proofFile && !params.proofUrl) {
    throw new Error('Veuillez fournir une capture/vidéo ou un lien de preuve.');
  }

  let metricValue = 1;
  if (cfg.metric_type !== 'binary') {
    const num = Number(params.metricValue);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(
        cfg.metric_type === 'time_asc'
          ? 'Veuillez renseigner un chrono valide (en millisecondes ou format M:SS.mmm).'
          : 'Veuillez renseigner un score numérique valide (> 0).'
      );
    }
    metricValue = num;
  }

  const thresholds = JSON.parse(item.thresholds_json || '{}');
  const evalRes = item.is_ladder
    ? { tierKey: 'ladder', tierLabel: cfg.ladder_title, points: 0 }
    : evaluateFeaturedTier(metricValue, thresholds, cfg.tiers, cfg.metric_type);

  const proofType = params.proofFile ? 'file' : 'link';

  const info = db
    .prepare(
      `INSERT INTO featured_submissions (
        user_id, item_id, metric_value, tier_key, points_awarded, status,
        proof_type, proof_url, proof_file, proof_note
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    )
    .run(
      params.userId,
      item.id,
      metricValue,
      evalRes.tierKey,
      evalRes.points,
      proofType,
      params.proofUrl || null,
      params.proofFile || null,
      params.proofNote || null
    );

  return db
    .prepare(
      `SELECT fs.*, fi.code AS item_code, fi.name AS item_name, fi.description AS item_description, fi.is_ladder,
              u.display_name, u.username
       FROM featured_submissions fs
       JOIN featured_items fi ON fi.id = fs.item_id
       JOIN users u ON u.id = fs.user_id
       WHERE fs.id = ?`
    )
    .get(info.lastInsertRowid);
}

export function reviewFeaturedSubmission(
  db: Database.Database,
  params: {
    submissionId: number;
    action: 'approve' | 'reject';
    reviewerId: string;
    rejectReason?: string;
  }
): any {
  const cfg = getEventConfig(db).featured;
  const sub = db
    .prepare(
      `SELECT fs.*, fi.code AS item_code, fi.name AS item_name, fi.is_ladder, fi.thresholds_json, u.display_name
       FROM featured_submissions fs
       JOIN featured_items fi ON fi.id = fs.item_id
       JOIN users u ON u.id = fs.user_id
       WHERE fs.id = ?`
    )
    .get(params.submissionId) as any;

  if (!sub) throw new Error(`Preuve vedette #${params.submissionId} introuvable.`);

  const tx = db.transaction(() => {
    if (params.action === 'approve') {
      const thresholds = JSON.parse(sub.thresholds_json || '{}');
      const evalRes = sub.is_ladder
        ? { tierKey: 'ladder', tierLabel: cfg.ladder_title, points: 0 }
        : evaluateFeaturedTier(sub.metric_value, thresholds, cfg.tiers, cfg.metric_type);

      db.prepare(
        `UPDATE featured_submissions
         SET status = 'validated', tier_key = ?, points_awarded = ?, reviewer_id = ?, reject_reason = NULL, reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(evalRes.tierKey, evalRes.points, params.reviewerId, sub.id);
    } else {
      db.prepare(
        `UPDATE featured_submissions
         SET status = 'rejected', reviewer_id = ?, reject_reason = ?, reviewed_at = datetime('now')
         WHERE id = ?`
      ).run(params.reviewerId, params.rejectReason || 'Preuve incomplète ou non conforme.', sub.id);
    }

    if (!sub.is_ladder) {
      syncUserStageLedger(db, sub.user_id, { id: sub.item_id, code: sub.item_code, name: sub.item_name, thresholds_json: sub.thresholds_json }, cfg);
    }
  });
  tx();

  if (sub.is_ladder) {
    recalculateFeaturedLadder(db);
  }

  return db
    .prepare(
      `SELECT fs.*, fi.code AS item_code, fi.name AS item_name, fi.is_ladder, u.display_name
       FROM featured_submissions fs
       JOIN featured_items fi ON fi.id = fs.item_id
       JOIN users u ON u.id = fs.user_id
       WHERE fs.id = ?`
    )
    .get(params.submissionId);
}

export function listPendingFeaturedProofs(db: Database.Database) {
  const cfg = getEventConfig(db).featured;
  const rows = db
    .prepare(
      `SELECT fs.*, fi.code AS item_code, fi.name AS item_name, fi.description AS item_description, fi.is_ladder,
              u.display_name, u.username, u.avatar
       FROM featured_submissions fs
       JOIN featured_items fi ON fi.id = fs.item_id
       JOIN users u ON u.id = fs.user_id
       WHERE fs.status = 'pending'
       ORDER BY fs.created_at ASC`
    )
    .all() as any[];

  return rows.map((r) => ({
    ...r,
    kind: 'featured',
    game_name: cfg.title,
    title: `${r.item_code} · ${r.item_name}`,
    description:
      r.item_description ||
      (cfg.metric_type === 'binary'
        ? `Épreuve ${cfg.title}`
        : `Valeur déclarée : ${formatMetricValue(r.metric_value, cfg.metric_type, cfg.metric_unit)}`),
    points: r.points_awarded,
    formatted_value: formatMetricValue(r.metric_value, cfg.metric_type, cfg.metric_unit),
    submitted_at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// CONNECTEUR TRACKMANIA (.Replay.gbx + XML-RPC Serveur Dédié)
// ---------------------------------------------------------------------------

export function submitTmnfReplay(
  db: Database.Database,
  params: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    explicitMapId?: string;
  }
) {
  const parsed = parseReplayGbx(params.buffer);
  if (!parsed.valid || !parsed.bestTimeMs || !parsed.mapUid) {
    throw new Error(parsed.error || 'Replay .gbx invalide.');
  }

  // Anti-triche #1 : Empreinte SHA-256 unique
  const duplicateHash = db
    .prepare(`SELECT id, user_id FROM featured_submissions WHERE external_hash = ?`)
    .get(parsed.sha256) as { id: number; user_id: string } | undefined;
  if (duplicateHash) {
    throw new Error('Ce fichier .Replay.gbx exact a déjà été soumis (partage ou doublon interdit).');
  }

  // Anti-triche #2 : Cohérence et unicité du login TMNF
  const user = db.prepare(`SELECT id, tmnf_login, display_name FROM users WHERE id = ?`).get(params.userId) as any;
  if (!user) throw new Error('Utilisateur introuvable.');

  if (parsed.playerLogin && parsed.playerLogin !== 'unknown_driver') {
    const otherOwner = db
      .prepare(`SELECT id, display_name FROM users WHERE LOWER(tmnf_login) = LOWER(?) AND id != ?`)
      .get(parsed.playerLogin, params.userId) as { id: string; display_name: string } | undefined;
    if (otherOwner) {
      throw new Error(
        `Anti-Triche : Le compte Trackmania "${parsed.playerLogin}" appartient déjà au joueur "${otherOwner.display_name}". Partage de replay interdit.`
      );
    }
  }

  if (user.tmnf_login && user.tmnf_login.toLowerCase() !== parsed.playerLogin!.toLowerCase()) {
    throw new Error(
      `Ce replay a été enregistré par le compte TMNF "${parsed.playerLogin}", mais votre profil est lié au login "${user.tmnf_login}".`
    );
  }

  let item = db.prepare(`SELECT * FROM featured_items WHERE external_uid = ? AND active = 1`).get(parsed.mapUid) as any;
  if (!item && params.explicitMapId) {
    const candidate = db.prepare(`SELECT * FROM featured_items WHERE id = ? AND active = 1`).get(params.explicitMapId) as any;
    if (candidate && candidate.external_uid === parsed.mapUid) {
      item = candidate;
    }
  }

  if (!item) {
    throw new Error(
      `L'UID de la map du replay ("${parsed.mapUid}") ne correspond à aucune piste configurée pour cette édition.`
    );
  }

  const lifecycle = getEventConfig(db);
  const cfg = lifecycle.featured;
  if (lifecycle.effective_phase === 'closed' || lifecycle.effective_phase === 'draft') {
    throw new Error('L’événement est clôturé ou en préparation : les dépôts de replays sont fermés.');
  }
  if (item.is_ladder && !lifecycle.ladder_unlocked) {
    throw new Error(
      lifecycle.ladder_locked
        ? `Le ${cfg.ladder_title} est clôturé.`
        : `🔒 La ${cfg.ladder_title} se débloque en Semaine ${cfg.ladder_unlock_act} (Acte ${cfg.ladder_unlock_act}) !`
    );
  }

  const timeMs = parsed.bestTimeMs;
  const thresholds = JSON.parse(item.thresholds_json || '{}');
  const evalRes = item.is_ladder
    ? { tierKey: 'none', tierLabel: 'Aucune', points: 0 }
    : evaluateFeaturedTier(timeMs, thresholds, cfg.tiers, 'time_asc');

  const medal = (['author', 'gold', 'silver', 'bronze'].includes(evalRes.tierKey) ? evalRes.tierKey : 'none') as
    | 'author'
    | 'gold'
    | 'silver'
    | 'bronze'
    | 'none';
  const medalPoints = item.is_ladder ? 0 : evalRes.points;

  const prevBest = db
    .prepare(
      `SELECT MIN(metric_value) AS best_time_ms, MAX(points_awarded) AS max_pts
       FROM featured_submissions
       WHERE user_id = ? AND item_id = ? AND status = 'validated'`
    )
    .get(params.userId, item.id) as { best_time_ms: number | null; max_pts: number | null };

  const previousPoints = prevBest?.max_pts || 0;
  const newPoints = Math.max(previousPoints, medalPoints);
  const deltaPoints = newPoints - previousPoints;
  const isPersonalBest = prevBest?.best_time_ms === null || timeMs < prevBest.best_time_ms;

  const tx = db.transaction(() => {
    if (!user.tmnf_login && parsed.playerLogin) {
      db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(parsed.playerLogin, params.userId);
    }

    db.prepare(
      `INSERT INTO featured_submissions (
        user_id, item_id, metric_value, tier_key, points_awarded, status,
        proof_type, external_hash, external_login, external_nickname, file_name, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, 'validated', 'gbx', ?, ?, ?, ?, datetime('now'))`
    ).run(
      params.userId,
      item.id,
      timeMs,
      medal,
      medalPoints,
      parsed.sha256,
      parsed.playerLogin,
      parsed.playerNickname || parsed.playerLogin,
      params.fileName
    );

    if (!item.is_ladder && newPoints > 0) {
      syncUserStageLedger(db, params.userId, item, cfg);
    }
  });
  tx();

  if (item.is_ladder) {
    recalculateFeaturedLadder(db);
  }

  return {
    parsed,
    map: hydrateFeaturedItem(item, cfg),
    medal,
    previousPoints,
    newPoints,
    deltaPoints,
    isPersonalBest,
  };
}

export function recordTmnfLiveServerFinish(
  db: Database.Database,
  params: {
    playerLogin: string;
    playerNickname?: string;
    mapUid: string;
    timeMs: number;
  }
) {
  const loginClean = params.playerLogin.trim().toLowerCase();
  const timeMs = Math.round(Number(params.timeMs));
  if (!loginClean || !Number.isFinite(timeMs) || timeMs <= 1000) {
    throw new Error('Paramètres de chrono serveur invalides.');
  }

  const user = db
    .prepare(
      `SELECT * FROM users
       WHERE LOWER(tmnf_login) = ? OR LOWER(username) = ?
       ORDER BY CASE WHEN LOWER(tmnf_login) = ? THEN 0 ELSE 1 END ASC
       LIMIT 1`
    )
    .get(loginClean, loginClean, loginClean) as any;

  const item = db.prepare(`SELECT * FROM featured_items WHERE external_uid = ? AND active = 1`).get(params.mapUid.trim()) as any;
  if (!user || !item) {
    return {
      matchedUser: user || null,
      map: item || null,
      medal: 'none' as const,
      formattedTime: formatTmTime(timeMs),
      deltaPoints: 0,
      isPersonalBest: false,
    };
  }

  const cfg = getEventConfig(db).featured;
  const thresholds = JSON.parse(item.thresholds_json || '{}');
  const evalRes = item.is_ladder
    ? { tierKey: 'none', tierLabel: 'Aucune', points: 0 }
    : evaluateFeaturedTier(timeMs, thresholds, cfg.tiers, 'time_asc');
  const medal = (['author', 'gold', 'silver', 'bronze'].includes(evalRes.tierKey) ? evalRes.tierKey : 'none') as
    | 'author'
    | 'gold'
    | 'silver'
    | 'bronze'
    | 'none';
  const medalPoints = item.is_ladder ? 0 : evalRes.points;

  const prevBest = db
    .prepare(
      `SELECT MIN(metric_value) AS best_time_ms, MAX(points_awarded) AS max_pts
       FROM featured_submissions
       WHERE user_id = ? AND item_id = ? AND status = 'validated'`
    )
    .get(user.id, item.id) as { best_time_ms: number | null; max_pts: number | null };

  const isPersonalBest = prevBest?.best_time_ms === null || timeMs < prevBest.best_time_ms;
  const previousPoints = prevBest?.max_pts || 0;
  const newPoints = Math.max(previousPoints, medalPoints);
  const deltaPoints = newPoints - previousPoints;

  if (isPersonalBest || deltaPoints > 0) {
    const syntheticHash = `live_xmlrpc_${user.id}_${item.id}_${timeMs}_${Date.now()}`;
    const tx = db.transaction(() => {
      if (!user.tmnf_login) {
        db.prepare(`UPDATE users SET tmnf_login = ? WHERE id = ?`).run(loginClean, user.id);
      }

      db.prepare(
        `INSERT INTO featured_submissions (
          user_id, item_id, metric_value, tier_key, points_awarded, status,
          proof_type, external_hash, external_login, external_nickname, file_name, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, 'validated', 'xmlrpc', ?, ?, ?, 'live_server_xmlrpc', datetime('now'))`
      ).run(user.id, item.id, timeMs, medal, medalPoints, syntheticHash, loginClean, params.playerNickname || user.display_name);

      if (!item.is_ladder && newPoints > 0) {
        syncUserStageLedger(db, user.id, item, cfg);
      }
    });
    tx();

    if (item.is_ladder) {
      recalculateFeaturedLadder(db);
    }
  }

  return {
    matchedUser: user,
    map: hydrateFeaturedItem(item, cfg),
    medal,
    formattedTime: formatTmTime(timeMs),
    deltaPoints,
    isPersonalBest,
  };
}

// ---------------------------------------------------------------------------
// CLASSEMENT D'UNE ÉPREUVE & SOUMISSIONS DU JOUEUR
// ---------------------------------------------------------------------------

export function getFeaturedItemLeaderboard(db: Database.Database, itemId: string) {
  const cfg = getEventConfig(db).featured;
  const item = db.prepare(`SELECT * FROM featured_items WHERE id = ?`).get(itemId) as any;
  if (!item) throw new Error('Épreuve introuvable.');

  const aggFn = cfg.metric_type === 'time_asc' ? 'MIN(fs.metric_value)' : 'MAX(fs.metric_value)';
  const orderDir = cfg.metric_type === 'time_asc' ? 'ASC' : 'DESC';

  const rows = db
    .prepare(
      `SELECT
         fs.user_id,
         u.display_name,
         u.tmnf_login,
         ${aggFn} AS best_value,
         MAX(fs.points_awarded) AS best_points,
         (
           SELECT f2.file_name
           FROM featured_submissions f2
           WHERE f2.user_id = fs.user_id AND f2.item_id = fs.item_id AND f2.status = 'validated'
           ORDER BY f2.metric_value ${orderDir}, f2.id ASC
           LIMIT 1
         ) AS best_file_name
       FROM featured_submissions fs
       JOIN users u ON u.id = fs.user_id
       WHERE fs.item_id = ? AND fs.status = 'validated'
       GROUP BY fs.user_id
       ORDER BY best_value ${orderDir}`
    )
    .all(itemId) as any[];

  const thresholds = JSON.parse(item.thresholds_json || '{}');
  const wrVal = rows.length > 0 ? rows[0].best_value : 0;

  const entries = rows.map((r, idx) => {
    const val = Number(r.best_value);
    const evalRes = item.is_ladder
      ? { tierKey: 'none', tierLabel: '—', points: 0 }
      : evaluateFeaturedTier(val, thresholds, cfg.tiers, cfg.metric_type);
    return {
      rank: idx + 1,
      user_id: r.user_id,
      display_name: r.display_name,
      tmnf_login: r.tmnf_login || null,
      best_value: val,
      best_time_ms: val,
      formatted_value: formatMetricValue(val, cfg.metric_type, cfg.metric_unit),
      formatted_time: formatMetricValue(val, cfg.metric_type, cfg.metric_unit),
      tier_key: evalRes.tierKey,
      tier_label: evalRes.tierLabel,
      medal: evalRes.tierKey,
      points: r.best_points || 0,
      delta_wr_ms: cfg.metric_type === 'time_asc' ? val - wrVal : wrVal - val,
      file_name: r.best_file_name || null,
    };
  });

  return {
    map: hydrateFeaturedItem(item, cfg),
    item: hydrateFeaturedItem(item, cfg),
    entries,
  };
}

export function getUserFeaturedSummary(db: Database.Database, userId: string) {
  const cfg = getEventConfig(db).featured;
  const aggFn = cfg.metric_type === 'time_asc' ? 'MIN(metric_value)' : 'MAX(metric_value)';

  const validated = db
    .prepare(
      `SELECT item_id, ${aggFn} AS best_value, MAX(points_awarded) AS best_points
       FROM featured_submissions
       WHERE user_id = ? AND status = 'validated'
       GROUP BY item_id`
    )
    .all(userId) as any[];

  const pending = db
    .prepare(
      `SELECT item_id, id, metric_value, status, reject_reason, created_at
       FROM featured_submissions
       WHERE user_id = ? AND status IN ('pending', 'rejected')
       ORDER BY id DESC`
    )
    .all(userId) as any[];

  const pendingByItem = new Map<string, any>();
  for (const p of pending) {
    if (!pendingByItem.has(p.item_id)) pendingByItem.set(p.item_id, p);
  }

  const byItem = new Map<string, any>();
  for (const r of validated) {
    byItem.set(r.item_id, {
      map_id: r.item_id,
      item_id: r.item_id,
      best_value: r.best_value,
      best_time_ms: r.best_value,
      best_points: r.best_points || 0,
      best_formatted: formatMetricValue(r.best_value, cfg.metric_type, cfg.metric_unit),
      best_time_formatted: formatMetricValue(r.best_value, cfg.metric_type, cfg.metric_unit),
      pending: pendingByItem.get(r.item_id) || null,
    });
  }
  for (const [itemId, p] of pendingByItem) {
    if (!byItem.has(itemId)) {
      byItem.set(itemId, {
        map_id: itemId,
        item_id: itemId,
        best_value: null,
        best_time_ms: null,
        best_points: 0,
        best_formatted: null,
        best_time_formatted: null,
        pending: p,
      });
    }
  }

  return Array.from(byItem.values());
}
