import type { FeatureKey, FeatureUsageRepository } from '../database/repositories/feature-usage.repository.ts';
import { notifyLogger } from '../utils/logger.ts';

/** Maps slash commands to feature keys */
const COMMAND_FEATURE_MAP: { [cmd: string]: FeatureKey } = {
  today: 'events_create',
  tomorrow: 'events_create',
  week: 'events_create',
  month: 'month_view',
  add: 'events_create',
  edit: 'events_edit',
  delete: 'events_edit',
  search: 'events_create',
  free: 'free_slots',
  settings: 'settings',
  import: 'import',
  holidays: 'holidays',
  birthdays: 'events_create',
  invite: 'sharing',
  invitations: 'sharing',
  share: 'sharing',
  connect_google: 'google_calendar',
  disconnect_google: 'google_calendar',
  google_status: 'google_calendar',
  log: 'history',
  contacts: 'contacts',
};

/** Maps callback data prefixes to feature keys */
const CALLBACK_FEATURE_MAP: { [prefix: string]: FeatureKey } = {
  ev: 'events_create', // view event
  ee: 'events_edit', // edit event
  ef: 'events_edit', // edit field
  ed: 'events_edit', // delete event
  edc: 'events_edit', // delete confirm
  er: 'recurrence', // recurrence settings
  erd: 'recurrence', // delete recurrence
  erm: 'reminders', // event reminder
  mn: 'month_view', // month navigation
  nf: 'reminders', // notification/reminder
  hl: 'holidays', // holiday management
  gc: 'google_calendar', // Google Calendar
  imd: 'month_view', // daily image
  imw: 'month_view', // weekly image
  inv: 'sharing', // invitation action
  st: 'settings', // settings
  sec: 'secretary', // secretary
  epr: 'sharing', // edit proposal accept/reject
};

/** Maps scene names to feature keys */
const SCENE_FEATURE_MAP: { [scene: string]: FeatureKey } = {
  'add-event': 'events_create',
  'edit-value': 'events_edit',
  import: 'import',
  timezone: 'settings',
};

/** Maps abstract actions to feature keys */
const ACTION_FEATURE_MAP: { [action: string]: FeatureKey } = {
  voice_message: 'events_create', // voice messages are usually to create/query events
  ics_file: 'import', // sending .ics files
  geolocation: 'geolocation', // sharing location pin
};

/**
 * Records feature usage from various entry points (commands, callbacks, scenes, etc.)
 * Silently ignores errors — feature tracking must never break core functionality.
 */
export function trackFeatureUsage(
  repo: FeatureUsageRepository | undefined,
  userId: number,
  source: 'command' | 'callback' | 'scene' | 'action',
  key: string,
): void {
  if (!repo) return;
  const map =
    source === 'command'
      ? COMMAND_FEATURE_MAP
      : source === 'callback'
        ? CALLBACK_FEATURE_MAP
        : source === 'scene'
          ? SCENE_FEATURE_MAP
          : ACTION_FEATURE_MAP;
  const featureKey = map[key];
  if (!featureKey) return;
  try {
    repo.record(userId, featureKey);
  } catch (err) {
    notifyLogger.warn({ err, userId, source, key }, 'Failed to record feature usage');
  }
}

/** Extract callback data prefix (everything before the first ':') */
export function callbackPrefix(data: string): string {
  const idx = data.indexOf(':');
  return idx === -1 ? data : data.slice(0, idx);
}
