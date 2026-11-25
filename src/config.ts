import type Database from 'better-sqlite3';

// ============================================================================
// CONFIGURATION MODULAIRE DE L'ÉDITION ACTIVE
// ----------------------------------------------------------------------------
// Centralise toutes les règles économiques, actes (1..3), lots, barèmes et
// configuration du Jeu Vedette (optionnel : 0 ou 1) dans `event_settings`.
// ============================================================================

export type StatusMode = 'auto' | 'draft' | 'registration' | 'act_1' | 'act_2' | 'act_3' | 'week1' | 'week2' | 'live' | 'closed';
export type EffectivePhase = 'draft' | 'registration' | 'act_1' | 'act_2' | 'act_3' | 'closed';
export type FeaturedConnector = 'standard' | 'tmnf_gbx';
export type MetricType = 'time_asc' | 'score_desc' | 'binary';

export interface EventAct {
  index: number; // 1, 2, 3
  name: string;
  start_at: string; // YYYY-MM-DDTHH:mm
}

export interface RegularityTier {
  days: number;
  points: number;
  label?: string;
}

export interface FeaturedTier {
  key: string;
  label: string;
  points: number;
}

export interface FeaturedServerInfo {
  enabled: boolean;
  label: string;
  address: string;
  join_url: string;
  login: string;
  help_text: string;
}

export interface FeaturedConfig {
  enabled: boolean;
  title: string;
  subtitle: string;
  game_id: string | null;
  connector: FeaturedConnector;
  metric_type: MetricType;
  metric_unit: string;
  stages_enabled: boolean;
  stages_title: string;
  tiers: FeaturedTier[];
  ladder_enabled: boolean;
  ladder_title: string;
  ladder_unlock_act: number;
  ladder_cutoff_at: string;
  ladder_points_scale: number[];
  server_info: FeaturedServerInfo;
}

export interface EventConfig {
  // Identité & lots
  event_name: string;
  event_subtitle: string;
  prizes: string[];
  tombola_prize: string;
  tombola_threshold: number;

  // Structure temporelle (1 à 3 actes)
  status_mode: StatusMode;
  acts_count: 1 | 2 | 3;
  acts: EventAct[];
  end_at: string;

  // Règles & barèmes des défis quotidiens
  min_selected_games: number;
  max_quests_per_game_per_act: number;
  daily_quests_count: number;
  daily_rerolls_max: number;
  quest_points: { easy: number; medium: number; hard: number };
  regularity_tiers: RegularityTier[];

  // Barème tournois par défaut (pré-rempli à la création d'un tournoi)
  default_tournament_scale: Record<string, number>;

  // Jeu Vedette (optionnel : 0 ou 1)
  featured: FeaturedConfig;

  // État calculé (cycle de vie)
  effective_phase: EffectivePhase;
  current_act: number; // 1..acts_count
  ladder_unlocked: boolean;
  ladder_locked: boolean;

  // Champs de compatibilité ascendante (UI / tests / bridge)
  start_at: string;
  week2_start_at: string;
  tmnf_cutoff_at: string;
  tmnf_playit_address: string;
  tmnf_join_url: string;
  tmnf_server_login: string;
  current_week: number;
  tmnf_weekly_unlocked: boolean;
  tmnf_weekly_locked: boolean;
}

export const DEFAULT_QUEST_POINTS = { easy: 10, medium: 15, hard: 25 };

export const DEFAULT_REGULARITY_TIERS: RegularityTier[] = [
  { days: 4, points: 20, label: 'Palier Régularité — 4 Jours Actifs' },
  { days: 8, points: 40, label: 'Palier Régularité — 8 Jours Actifs' },
  { days: 12, points: 60, label: 'Palier Régularité — 12 Jours Actifs' },
];

export const DEFAULT_TOURNAMENT_SCALE: Record<string, number> = {
  '1': 200,
  '2': 140,
  '3': 90,
  '4': 90,
  '5': 50,
  '6': 50,
  '7': 50,
  '8': 50,
  default: 25,
};

export const DEFAULT_FEATURED_TIERS_TMNF: FeaturedTier[] = [
  { key: 'bronze', label: 'Bronze', points: 5 },
  { key: 'silver', label: 'Argent', points: 10 },
  { key: 'gold', label: 'Or', points: 20 },
  { key: 'author', label: 'Auteur', points: 30 },
];

export const DEFAULT_LADDER_POINTS_SCALE = [150, 110, 80, 50, 50, 50, 30, 30, 30, 30];

export function defaultFeaturedConfig(env = process.env): FeaturedConfig {
  return {
    enabled: true,
    title: 'Trackmania',
    subtitle: 'Acte I : pistes solo à médailles. Acte II : la map du serveur ouvre, le top 10 marque des points.',
    game_id: 'tmnf',
    connector: 'tmnf_gbx',
    metric_type: 'time_asc',
    metric_unit: '',
    stages_enabled: true,
    stages_title: 'Chasse aux médailles',
    tiers: DEFAULT_FEATURED_TIERS_TMNF.map((t) => ({ ...t })),
    ladder_enabled: true,
    ladder_title: 'Map du serveur',
    ladder_unlock_act: 2,
    ladder_cutoff_at: '2026-11-28T20:30',
    ladder_points_scale: [...DEFAULT_LADDER_POINTS_SCALE],
    server_info: {
      enabled: true,
      label: 'Serveur Trackmania',
      address: env.TMNF_PLAYIT_ADDRESS || 'hgw-tmnf.playit.gg:2350',
      join_url: env.TMNF_JOIN_URL || 'tmtp://#join=hgw_stadium_2026',
      login: env.TMNF_SERVER_LOGIN || 'hgw_stadium_2026',
      help_text: 'Visible en haut à droite du menu du jeu. Il doit correspondre à tes replays et sert à remonter tes chronos du serveur.',
    },
  };
}

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && parsed !== undefined ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeStatusMode(raw?: string): StatusMode {
  const valid: StatusMode[] = ['auto', 'draft', 'registration', 'act_1', 'act_2', 'act_3', 'week1', 'week2', 'live', 'closed'];
  return valid.includes(raw as StatusMode) ? (raw as StatusMode) : 'auto';
}

export function getEventConfig(db: Database.Database, now: Date = new Date()): EventConfig {
  const rows = db.prepare(`SELECT key, value FROM event_settings`).all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const eventName = map.get('event_name') || 'Hextaz Games Week';
  const eventSubtitle =
    map.get('event_subtitle') || 'Deux semaines de défis, de chronos et de tournois live entre amis.';
  const prizes = safeJsonParse<string[]>(map.get('prizes_json'), [
    'Carte cadeau 10 €',
    'Discord Nitro',
    'Abonnement Twitch',
  ]);
  const tombolaPrize = map.get('tombola_prize') || 'Lot surprise Tombola';
  const tombolaThreshold = clampInt(map.get('tombola_threshold'), 300, 1, 100000);

  const legacyStart = map.get('start_at') || '2026-11-16T03:00';
  const legacyWeek2 = map.get('week2_start_at') || '2026-11-23T03:00';
  const endAt = map.get('end_at') || '2026-11-29T18:00';

  const actsCount = clampInt(map.get('acts_count'), 2, 1, 3) as 1 | 2 | 3;
  const rawActs = safeJsonParse<EventAct[]>(map.get('acts_json'), []);
  const defaultActNames = ['Acte I', 'Acte II', 'Acte III'];
  const defaultActDates = [legacyStart, legacyWeek2, '2026-11-30T03:00'];

  const acts: EventAct[] = [];
  for (let i = 1; i <= actsCount; i++) {
    const found = rawActs.find((a) => Number(a?.index) === i) || rawActs[i - 1];
    acts.push({
      index: i,
      name: String(found?.name || defaultActNames[i - 1]).trim() || defaultActNames[i - 1],
      start_at: String(found?.start_at || defaultActDates[i - 1]).trim() || defaultActDates[i - 1],
    });
  }

  const minSelectedGames = clampInt(map.get('min_selected_games'), 4, 1, 20);
  const maxQuestsPerGamePerAct = clampInt(map.get('max_quests_per_game_per_act'), 4, 1, 50);
  const dailyQuestsCount = clampInt(map.get('daily_quests_count'), 3, 1, 6);
  const dailyRerollsMax = clampInt(map.get('daily_rerolls_max'), 1, 0, 5);

  const rawQuestPoints = safeJsonParse<Partial<typeof DEFAULT_QUEST_POINTS>>(map.get('quest_points_json'), {});
  const questPoints = {
    easy: clampInt(rawQuestPoints.easy, DEFAULT_QUEST_POINTS.easy, 1, 1000),
    medium: clampInt(rawQuestPoints.medium, DEFAULT_QUEST_POINTS.medium, 1, 1000),
    hard: clampInt(rawQuestPoints.hard, DEFAULT_QUEST_POINTS.hard, 1, 1000),
  };

  const rawRegTiers = safeJsonParse<RegularityTier[]>(map.get('regularity_tiers_json'), DEFAULT_REGULARITY_TIERS);
  const regularityTiers = (Array.isArray(rawRegTiers) ? rawRegTiers : DEFAULT_REGULARITY_TIERS)
    .filter((t) => Number.isFinite(Number(t?.days)) && Number(t.days) > 0 && Number.isFinite(Number(t?.points)) && Number(t.points) > 0)
    .map((t) => ({
      days: Math.trunc(Number(t.days)),
      points: Math.trunc(Number(t.points)),
      label: String(t.label || `Palier Régularité — ${Math.trunc(Number(t.days))} Jours Actifs`).trim(),
    }))
    .sort((a, b) => a.days - b.days);

  const defaultTournamentScale = safeJsonParse<Record<string, number>>(
    map.get('default_tournament_scale_json'),
    DEFAULT_TOURNAMENT_SCALE
  );

  // Featured config (avec fusion douce des clés legacy TMNF)
  const baseFeatured = defaultFeaturedConfig();
  const rawFeat = safeJsonParse<Partial<FeaturedConfig>>(map.get('featured_config_json'), {});
  const legacyCutoff = map.get('tmnf_cutoff_at');
  const legacyPlayit = map.get('tmnf_playit_address');
  const legacyJoin = map.get('tmnf_join_url');
  const legacyLogin = map.get('tmnf_server_login');

  const connector: FeaturedConnector = rawFeat.connector === 'standard' ? 'standard' : 'tmnf_gbx';
  const metricType: MetricType =
    connector === 'tmnf_gbx'
      ? 'time_asc'
      : rawFeat.metric_type === 'time_asc' || rawFeat.metric_type === 'score_desc' || rawFeat.metric_type === 'binary'
      ? rawFeat.metric_type
      : 'score_desc';

  const rawTiers = Array.isArray(rawFeat.tiers) && rawFeat.tiers.length > 0 ? rawFeat.tiers : baseFeatured.tiers;
  const tiers: FeaturedTier[] = rawTiers
    .filter((t) => t && String(t.key || '').trim() !== '')
    .map((t) => ({
      key: String(t.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'),
      label: String(t.label || t.key).trim().slice(0, 40),
      points: clampInt(t.points, 10, 0, 10000),
    }));

  const rawLadderScale = Array.isArray(rawFeat.ladder_points_scale)
    ? rawFeat.ladder_points_scale.map((n) => clampInt(n, 0, 0, 10000))
    : baseFeatured.ladder_points_scale;

  const featured: FeaturedConfig = {
    enabled: rawFeat.enabled !== undefined ? Boolean(rawFeat.enabled) : baseFeatured.enabled,
    title: String(rawFeat.title || baseFeatured.title).trim().slice(0, 60) || baseFeatured.title,
    subtitle: String(rawFeat.subtitle ?? baseFeatured.subtitle).trim().slice(0, 260),
    game_id: rawFeat.game_id !== undefined ? (rawFeat.game_id ? String(rawFeat.game_id) : null) : baseFeatured.game_id,
    connector,
    metric_type: metricType,
    metric_unit: String(rawFeat.metric_unit ?? baseFeatured.metric_unit).trim().slice(0, 20),
    stages_enabled: rawFeat.stages_enabled !== undefined ? Boolean(rawFeat.stages_enabled) : baseFeatured.stages_enabled,
    stages_title: String(rawFeat.stages_title || baseFeatured.stages_title).trim().slice(0, 60),
    tiers: tiers.length > 0 ? tiers : baseFeatured.tiers,
    ladder_enabled: rawFeat.ladder_enabled !== undefined ? Boolean(rawFeat.ladder_enabled) : baseFeatured.ladder_enabled,
    ladder_title: String(rawFeat.ladder_title || baseFeatured.ladder_title).trim().slice(0, 60),
    ladder_unlock_act: clampInt(rawFeat.ladder_unlock_act, Math.min(2, actsCount), 1, actsCount),
    ladder_cutoff_at: String(rawFeat.ladder_cutoff_at || legacyCutoff || baseFeatured.ladder_cutoff_at).trim(),
    ladder_points_scale: rawLadderScale.length > 0 ? rawLadderScale : baseFeatured.ladder_points_scale,
    server_info: {
      enabled: rawFeat.server_info?.enabled !== undefined ? Boolean(rawFeat.server_info.enabled) : connector === 'tmnf_gbx',
      label: String(rawFeat.server_info?.label || baseFeatured.server_info.label).trim().slice(0, 60),
      address: String(rawFeat.server_info?.address ?? legacyPlayit ?? baseFeatured.server_info.address).trim().slice(0, 160),
      join_url: String(rawFeat.server_info?.join_url ?? legacyJoin ?? baseFeatured.server_info.join_url).trim().slice(0, 240),
      login: String(rawFeat.server_info?.login ?? legacyLogin ?? baseFeatured.server_info.login).trim().slice(0, 80),
      help_text: String(rawFeat.server_info?.help_text ?? baseFeatured.server_info.help_text).trim().slice(0, 300),
    },
  };

  // Calcul de la phase effective
  const statusMode = normalizeStatusMode(map.get('status_mode'));
  const nowMs = now.getTime();
  const endMs = Date.parse(endAt);

  let effectivePhase: EffectivePhase = 'act_1';
  if (statusMode === 'draft') {
    effectivePhase = 'draft';
  } else if (statusMode === 'registration') {
    effectivePhase = 'registration';
  } else if (statusMode === 'closed') {
    effectivePhase = 'closed';
  } else if (statusMode === 'week1' || statusMode === 'act_1') {
    effectivePhase = 'act_1';
  } else if (statusMode === 'week2' || statusMode === 'live' || statusMode === 'act_2') {
    effectivePhase = actsCount >= 2 ? 'act_2' : 'act_1';
  } else if (statusMode === 'act_3') {
    effectivePhase = actsCount >= 3 ? 'act_3' : actsCount === 2 ? 'act_2' : 'act_1';
  } else {
    const firstStartMs = Date.parse(acts[0].start_at);
    if (Number.isFinite(firstStartMs) && nowMs < firstStartMs) {
      effectivePhase = 'registration';
    } else if (Number.isFinite(endMs) && nowMs >= endMs) {
      effectivePhase = 'closed';
    } else {
      let activeIdx = 1;
      for (const act of acts) {
        const ms = Date.parse(act.start_at);
        if (Number.isFinite(ms) && nowMs >= ms) {
          activeIdx = act.index;
        }
      }
      effectivePhase = (`act_${activeIdx}` as EffectivePhase);
    }
  }

  let currentAct = 1;
  if (effectivePhase === 'act_2') currentAct = 2;
  else if (effectivePhase === 'act_3') currentAct = 3;
  else if (effectivePhase === 'closed') currentAct = actsCount;

  const cutoffMs = Date.parse(featured.ladder_cutoff_at);
  const cutoffPassed = statusMode === 'auto' && Number.isFinite(cutoffMs) && nowMs >= cutoffMs;
  const inPlayablePhase = effectivePhase === 'act_1' || effectivePhase === 'act_2' || effectivePhase === 'act_3';
  const ladderUnlocked = featured.enabled && featured.ladder_enabled && inPlayablePhase && currentAct >= featured.ladder_unlock_act && !cutoffPassed;
  const ladderLocked = effectivePhase === 'closed' || cutoffPassed;

  return {
    event_name: eventName,
    event_subtitle: eventSubtitle,
    prizes: prizes.length >= 3 ? prizes.slice(0, 5) : ['Carte cadeau 10 €', 'Discord Nitro', 'Abonnement Twitch'],
    tombola_prize: tombolaPrize,
    tombola_threshold: tombolaThreshold,
    status_mode: statusMode,
    acts_count: actsCount,
    acts,
    end_at: endAt,
    min_selected_games: minSelectedGames,
    max_quests_per_game_per_act: maxQuestsPerGamePerAct,
    daily_quests_count: dailyQuestsCount,
    daily_rerolls_max: dailyRerollsMax,
    quest_points: questPoints,
    regularity_tiers: regularityTiers,
    default_tournament_scale: defaultTournamentScale,
    featured,
    effective_phase: effectivePhase,
    current_act: currentAct,
    ladder_unlocked: ladderUnlocked,
    ladder_locked: ladderLocked,
    // Alias de compatibilité
    start_at: acts[0].start_at,
    week2_start_at: acts[1]?.start_at || legacyWeek2,
    tmnf_cutoff_at: featured.ladder_cutoff_at,
    tmnf_playit_address: featured.server_info.address,
    tmnf_join_url: featured.server_info.join_url,
    tmnf_server_login: featured.server_info.login,
    current_week: currentAct,
    tmnf_weekly_unlocked: ladderUnlocked,
    tmnf_weekly_locked: ladderLocked,
  };
}

export interface EventConfigPatch {
  event_name?: string;
  event_subtitle?: string;
  prizes?: string[];
  tombola_prize?: string;
  tombola_threshold?: number;
  status_mode?: string;
  acts_count?: number;
  acts?: EventAct[];
  end_at?: string;
  min_selected_games?: number;
  max_quests_per_game_per_act?: number;
  daily_quests_count?: number;
  daily_rerolls_max?: number;
  quest_points?: { easy: number; medium: number; hard: number };
  regularity_tiers?: RegularityTier[];
  default_tournament_scale?: Record<string, number>;
  featured?: Partial<FeaturedConfig>;
  // Champs legacy acceptés pour rétrocompatibilité
  start_at?: string;
  week2_start_at?: string;
  tmnf_cutoff_at?: string;
  tmnf_playit_address?: string;
  tmnf_join_url?: string;
  tmnf_server_login?: string;
  weekly_map_uid?: string;
}

export function updateEventConfig(db: Database.Database, patch: EventConfigPatch): EventConfig {
  const current = getEventConfig(db);
  const upsert = db.prepare(`
    INSERT INTO event_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `);

  const tx = db.transaction(() => {
    if (typeof patch.event_name === 'string' && patch.event_name.trim()) {
      upsert.run('event_name', patch.event_name.trim().slice(0, 100));
    }
    if (typeof patch.event_subtitle === 'string') {
      upsert.run('event_subtitle', patch.event_subtitle.trim().slice(0, 260));
    }
    if (Array.isArray(patch.prizes)) {
      const cleaned = patch.prizes.map((p) => String(p || '').trim().slice(0, 80)).filter(Boolean);
      if (cleaned.length >= 1) {
        upsert.run('prizes_json', JSON.stringify(cleaned));
      }
    }
    if (typeof patch.tombola_prize === 'string') {
      upsert.run('tombola_prize', patch.tombola_prize.trim().slice(0, 100));
    }
    if (patch.tombola_threshold !== undefined) {
      upsert.run('tombola_threshold', String(clampInt(patch.tombola_threshold, current.tombola_threshold, 1, 100000)));
    }
    if (typeof patch.status_mode === 'string' && patch.status_mode.trim()) {
      upsert.run('status_mode', normalizeStatusMode(patch.status_mode.trim()));
    }

    // Actes & dates
    const nextActsCount =
      patch.acts_count !== undefined
        ? (clampInt(patch.acts_count, current.acts_count, 1, 3) as 1 | 2 | 3)
        : current.acts_count;
    let nextActs: EventAct[] = current.acts.map((a) => ({ ...a }));
    if (Array.isArray(patch.acts) && patch.acts.length > 0) {
      nextActs = [];
      for (let i = 1; i <= nextActsCount; i++) {
        const src = patch.acts.find((a) => Number(a?.index) === i) || patch.acts[i - 1] || current.acts[i - 1];
        nextActs.push({
          index: i,
          name: String(src?.name || `Acte ${['I', 'II', 'III'][i - 1]}`).trim().slice(0, 40),
          start_at: String(src?.start_at || current.acts[i - 1]?.start_at || current.start_at).trim(),
        });
      }
    } else {
      while (nextActs.length < nextActsCount) {
        const idx = nextActs.length + 1;
        nextActs.push({
          index: idx,
          name: `Acte ${['I', 'II', 'III'][idx - 1]}`,
          start_at: current.acts[idx - 1]?.start_at || current.week2_start_at,
        });
      }
      nextActs = nextActs.slice(0, nextActsCount);
    }
    if (typeof patch.start_at === 'string' && patch.start_at.trim()) {
      nextActs[0].start_at = patch.start_at.trim();
    }
    if (typeof patch.week2_start_at === 'string' && patch.week2_start_at.trim() && nextActs[1]) {
      nextActs[1].start_at = patch.week2_start_at.trim();
    }

    upsert.run('acts_count', String(nextActsCount));
    upsert.run('acts_json', JSON.stringify(nextActs));
    upsert.run('start_at', nextActs[0].start_at);
    if (nextActs[1]) upsert.run('week2_start_at', nextActs[1].start_at);

    if (typeof patch.end_at === 'string' && patch.end_at.trim()) {
      upsert.run('end_at', patch.end_at.trim());
    }

    // Règles défis
    if (patch.min_selected_games !== undefined) {
      upsert.run('min_selected_games', String(clampInt(patch.min_selected_games, current.min_selected_games, 1, 20)));
    }
    if (patch.max_quests_per_game_per_act !== undefined) {
      upsert.run(
        'max_quests_per_game_per_act',
        String(clampInt(patch.max_quests_per_game_per_act, current.max_quests_per_game_per_act, 1, 50))
      );
    }
    if (patch.daily_quests_count !== undefined) {
      upsert.run('daily_quests_count', String(clampInt(patch.daily_quests_count, current.daily_quests_count, 1, 6)));
    }
    if (patch.daily_rerolls_max !== undefined) {
      upsert.run('daily_rerolls_max', String(clampInt(patch.daily_rerolls_max, current.daily_rerolls_max, 0, 5)));
    }
    if (patch.quest_points) {
      const nextQp = {
        easy: clampInt(patch.quest_points.easy, current.quest_points.easy, 1, 1000),
        medium: clampInt(patch.quest_points.medium, current.quest_points.medium, 1, 1000),
        hard: clampInt(patch.quest_points.hard, current.quest_points.hard, 1, 1000),
      };
      upsert.run('quest_points_json', JSON.stringify(nextQp));
      // Mettre à jour les points des quêtes du catalogue selon le nouveau barème
      db.prepare(`UPDATE quests SET points = ? WHERE difficulty = 'easy'`).run(nextQp.easy);
      db.prepare(`UPDATE quests SET points = ? WHERE difficulty = 'medium'`).run(nextQp.medium);
      db.prepare(`UPDATE quests SET points = ? WHERE difficulty = 'hard'`).run(nextQp.hard);
    }
    if (Array.isArray(patch.regularity_tiers)) {
      const cleaned = patch.regularity_tiers
        .filter((t) => Number(t?.days) > 0 && Number(t?.points) > 0)
        .map((t) => ({
          days: clampInt(t.days, 1, 1, 90),
          points: clampInt(t.points, 10, 1, 5000),
          label: String(t.label || `Palier Régularité — ${clampInt(t.days, 1, 1, 90)} Jours Actifs`).trim().slice(0, 100),
        }))
        .sort((a, b) => a.days - b.days);
      upsert.run('regularity_tiers_json', JSON.stringify(cleaned));
    }
    if (patch.default_tournament_scale && typeof patch.default_tournament_scale === 'object') {
      const scale: Record<string, number> = {};
      for (const [k, v] of Object.entries(patch.default_tournament_scale)) {
        if (/^(\d+|default)$/.test(k)) {
          scale[k] = clampInt(v, 0, 0, 10000);
        }
      }
      if (Object.keys(scale).length > 0) {
        upsert.run('default_tournament_scale_json', JSON.stringify(scale));
      }
    }

    // Jeu Vedette (fusion propre + champs legacy TMNF)
    const hasFeaturedUpdate =
      patch.featured !== undefined ||
      patch.tmnf_cutoff_at !== undefined ||
      patch.tmnf_playit_address !== undefined ||
      patch.tmnf_join_url !== undefined ||
      patch.tmnf_server_login !== undefined;

    if (hasFeaturedUpdate) {
      const f = patch.featured || {};
      const merged: FeaturedConfig = {
        ...current.featured,
        ...f,
        server_info: {
          ...current.featured.server_info,
          ...(f.server_info || {}),
        },
      };
      if (typeof patch.tmnf_cutoff_at === 'string' && patch.tmnf_cutoff_at.trim()) {
        merged.ladder_cutoff_at = patch.tmnf_cutoff_at.trim();
        upsert.run('tmnf_cutoff_at', merged.ladder_cutoff_at);
      }
      if (typeof patch.tmnf_playit_address === 'string' && patch.tmnf_playit_address.trim()) {
        merged.server_info.address = patch.tmnf_playit_address.trim();
        upsert.run('tmnf_playit_address', merged.server_info.address);
      }
      if (typeof patch.tmnf_join_url === 'string' && patch.tmnf_join_url.trim()) {
        merged.server_info.join_url = patch.tmnf_join_url.trim();
        upsert.run('tmnf_join_url', merged.server_info.join_url);
      }
      if (typeof patch.tmnf_server_login === 'string' && patch.tmnf_server_login.trim()) {
        merged.server_info.login = patch.tmnf_server_login.trim();
        upsert.run('tmnf_server_login', merged.server_info.login);
      }
      merged.ladder_unlock_act = clampInt(merged.ladder_unlock_act, Math.min(2, nextActsCount), 1, nextActsCount);
      upsert.run('featured_config_json', JSON.stringify(merged));
    }

    if (typeof patch.weekly_map_uid === 'string' && patch.weekly_map_uid.trim() !== '') {
      const uid = patch.weekly_map_uid.trim();
      db.prepare(`UPDATE featured_items SET external_uid = ? WHERE is_ladder = 1`).run(uid);
      // Maintenir la table legacy si présente
      try {
        db.prepare(`UPDATE tmnf_maps SET uid = ? WHERE is_weekly = 1`).run(uid);
      } catch {
        // table absente
      }
    }
  });

  tx();
  return getEventConfig(db);
}
