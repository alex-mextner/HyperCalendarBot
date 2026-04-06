import type { Database } from 'bun:sqlite';
import type { FeatureUsageRow } from '../types.ts';

/** Well-known feature keys for tip filtering */
export const FEATURE_KEYS = {
  EVENTS_CREATE: 'events_create',
  EVENTS_EDIT: 'events_edit',
  REMINDERS: 'reminders',
  SHARING: 'sharing',
  GOOGLE_CALENDAR: 'google_calendar',
  VOICE_CALLS: 'voice_calls',
  CONTACTS: 'contacts',
  HOLIDAYS: 'holidays',
  IMPORT: 'import',
  FREE_SLOTS: 'free_slots',
  MONTH_VIEW: 'month_view',
  SECRETARY: 'secretary',
  QUIET_HOURS: 'quiet_hours',
  MORNING_AGENDA: 'morning_agenda',
  EVENING_REVIEW: 'evening_review',
  HISTORY: 'history',
  SETTINGS: 'settings',
  RECURRENCE: 'recurrence',
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];

export class FeatureUsageRepository {
  constructor(private db: Database) {}

  /** Record that a user used a feature (upsert: increment count, update timestamp) */
  record(userId: number, featureKey: FeatureKey): void {
    this.db
      .prepare(
        `INSERT INTO feature_usage (user_id, feature_key, use_count, last_used_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT (user_id, feature_key)
         DO UPDATE SET use_count = use_count + 1, last_used_at = datetime('now')`,
      )
      .run(userId, featureKey);
  }

  /** Get all feature usage for a user */
  getForUser(userId: number): FeatureUsageRow[] {
    return this.db
      .prepare('SELECT user_id, feature_key, use_count, last_used_at FROM feature_usage WHERE user_id = ?')
      .all(userId) as FeatureUsageRow[];
  }

  /** Get usage for a specific feature */
  getOne(userId: number, featureKey: string): FeatureUsageRow | null {
    return this.db
      .prepare(
        'SELECT user_id, feature_key, use_count, last_used_at FROM feature_usage WHERE user_id = ? AND feature_key = ?',
      )
      .get(userId, featureKey) as FeatureUsageRow | null;
  }

  /**
   * Get features the user used frequently (>= minCount) but not recently (> daysAgo days).
   * These are candidates for "re-engagement" tips.
   */
  getStaleFeatures(userId: number, minCount: number, daysAgo: number): FeatureUsageRow[] {
    return this.db
      .prepare(
        `SELECT user_id, feature_key, use_count, last_used_at FROM feature_usage
         WHERE user_id = ? AND use_count >= ? AND last_used_at < datetime('now', ?)`,
      )
      .all(userId, minCount, `-${daysAgo} days`) as FeatureUsageRow[];
  }
}
