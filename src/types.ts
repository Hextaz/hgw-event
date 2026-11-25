// ============================================================================
// TYPES DOMAINE & LIGNES SQLITE PARTAGÉS (TypeScript strict, zéro `any`)
// ============================================================================

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  tmnf_login: string | null;
  is_admin: number;
  reroll_day_key: string | null;
  rerolls_used: number;
  created_at: string;
}

export interface GameRow {
  id: string;
  name: string;
  short_name: string;
  emoji: string;
  platforms: string;
  is_universal: number;
  sort_order: number;
  logo_url: string | null;
  active: number;
}

export interface GameWithStatsRow extends GameRow {
  quest_count: number;
  active_quest_count: number;
  player_count: number;
  usage_count: number;
}

export interface QuestRow {
  id: string;
  game_id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  points: number;
  proof_hint: string;
  unlock_week: number;
  active: number;
}

export interface QuestWithStatsRow extends QuestRow {
  usage_count: number;
  validated_count: number;
  rerolled_count: number;
}

export type DailyAssignmentStatus = 'open' | 'submitted' | 'validated' | 'rejected' | 'expired' | 'rerolled';

export interface DailyAssignmentRow {
  id: number;
  user_id: string;
  quest_id: string;
  day_key: string;
  week_key: string;
  status: DailyAssignmentStatus;
  proof_type: string | null;
  proof_url: string | null;
  proof_file: string | null;
  proof_note: string | null;
  discord_message_id: string | null;
  reviewer_id: string | null;
  reject_reason: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface DailyAssignmentDetailRow extends DailyAssignmentRow {
  title: string;
  description: string;
  difficulty: Difficulty;
  points: number;
  game_id: string;
  proof_hint?: string;
  unlock_week?: number;
  game_name: string;
  game_emoji: string;
  display_name?: string;
  username?: string;
  avatar?: string | null;
}

export interface FeaturedItemRow {
  id: string;
  code: string;
  name: string;
  description: string;
  is_ladder: number;
  external_uid: string | null;
  thresholds_json: string;
  metadata_json: string;
  active: number;
  sort_order: number;
  submission_count?: number;
}

export interface HydratedFeaturedItem extends FeaturedItemRow {
  thresholds: Record<string, number>;
  metadata: Record<string, unknown>;
  uid: string;
  is_weekly: number;
  environment: string;
  author_ms: number;
  gold_ms: number;
  silver_ms: number;
  bronze_ms: number;
  author_formatted: string;
  gold_formatted: string;
  silver_formatted: string;
  bronze_formatted: string;
  thresholds_formatted: Record<string, string>;
  wr_value?: number | null;
  wr_time_ms?: number | null;
  wr_formatted?: string | null;
  wr_holder?: string | null;
}

export type FeaturedSubmissionStatus = 'pending' | 'validated' | 'rejected';

export interface FeaturedSubmissionRow {
  id: number;
  user_id: string;
  item_id: string;
  metric_value: number;
  tier_key: string;
  points_awarded: number;
  status: FeaturedSubmissionStatus;
  proof_type: string | null;
  proof_url: string | null;
  proof_file: string | null;
  proof_note: string | null;
  external_hash: string | null;
  external_login: string | null;
  external_nickname: string | null;
  file_name: string | null;
  discord_message_id: string | null;
  reviewer_id: string | null;
  reject_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export interface FeaturedSubmissionDetailRow extends FeaturedSubmissionRow {
  item_code: string;
  item_name: string;
  item_description?: string;
  is_ladder: number;
  thresholds_json?: string;
  display_name: string;
  username?: string;
  avatar?: string | null;
}

export interface FeaturedLadderEntry {
  rank: number;
  user_id: string;
  display_name: string;
  avatar: string | null;
  best_value: number;
  best_time_ms: number;
  formatted_value: string;
  formatted_time: string;
  player_login: string;
  projected_points: number;
}

export interface TournamentRow {
  id: string;
  name: string;
  emoji: string;
  game_id: string;
  scheduled_label: string;
  scheduled_iso: string;
  mode_label: string;
  team_size: number;
  is_major: number;
  scoring_mode: 'direct' | 'rounds';
  rounds_count: number;
  round_presets_json: string;
  bracket_url: string | null;
  points_scale_json: string;
  status: 'upcoming' | 'checkin' | 'live' | 'completed';
  active: number;
  sort_order: number;
}

export interface TournamentRegistrationRow {
  tournament_id: string;
  user_id: string;
  pool: number;
  checked_in: number;
  team_number: number | null;
  team_name: string | null;
  placement: number | null;
  fg_shows_json: string;
  fg_total_score: number;
  round_scores_json: string;
  round_total_score: number;
  points_awarded: number;
  registered_at: string;
}

export interface TournamentRegistrationDetailRow extends TournamentRegistrationRow {
  display_name: string;
  avatar: string | null;
}

export interface PointsLedgerRow {
  id: number;
  user_id: string;
  source_type: 'daily' | 'tmnf_medal' | 'tmnf_weekly' | 'featured_stage' | 'featured_ladder' | 'tournament' | 'manual';
  source_ref: string;
  category: 'async' | 'live';
  points: number;
  label: string;
  created_at: string;
  updated_at: string;
}

export interface LeaderboardEntry {
  rank: number;
  id: string;
  username: string;
  display_name: string;
  avatar: string | null;
  tmnf_login: string | null;
  async_points: number;
  live_points: number;
  total_points: number;
  quests_validated: number;
  active_days_count: number;
  featured_stages_count: number;
  tmnf_medals_count: number;
  tombola_eligible: boolean;
  tombola_progress_pct: number;
}

export interface EditionArchiveRow {
  id: string;
  name: string;
  subtitle: string;
  started_at: string | null;
  ended_at: string | null;
  archived_at: string;
  snapshot_json: string;
}

export interface RegularitySummary {
  activeDaysCount: number;
  totalBonusPoints: number;
  tiers: { days: number; points: number; unlocked: boolean }[];
}

export function errorMessage(err: unknown, fallback = 'Erreur interne.'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}
