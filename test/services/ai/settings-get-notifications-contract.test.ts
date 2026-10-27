// Pins manage_settings `get` (every category and the no-category aggregate) and the
// notifications `update` patch, so handleGet/updateNotifications can be split into
// per-category helpers without changing the tool-result JSON or error text.
import { describe, expect, test } from 'bun:test';
import type { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import type {
  NotificationPreferencesRow,
  SharingSettings,
  User,
  UserCallSettings,
} from '../../../src/database/types.ts';
import { handleManageSettings, type ManageSettingsInput } from '../../../src/services/ai/tool-handlers/settings.ts';
import type {
  AgentContext,
  CallsCapability,
  NotificationsCapability,
  SharingCapability,
} from '../../../src/services/ai/types.ts';
import { agentContext, STORED_AT, userRow } from './context-fixtures.ts';
import { partialOf } from './partial-stubs.ts';

type NotificationUpdatesInput = NonNullable<Extract<ManageSettingsInput, { category: 'notifications' }>['updates']>;

const USER_ID = 7;

function makeCtx(extra: Partial<AgentContext> = {}): AgentContext {
  return agentContext({
    user: userRow({ telegram_id: USER_ID, timezone: 'Europe/Kyiv', language: 'en' }),
    chatId: USER_ID,
    ...extra,
  });
}

/** A stored row from before default_event_duration_minutes became NOT NULL: NULL cannot be typed, only parsed. */
function userWithNullDuration(): User {
  const stored: User = JSON.parse(
    JSON.stringify({
      ...userRow({ telegram_id: USER_ID, timezone: 'Europe/Kyiv' }),
      default_event_duration_minutes: null,
    }),
  );
  return stored;
}

function notificationPrefsRow(overrides: Partial<NotificationPreferencesRow> = {}): NotificationPreferencesRow {
  return {
    user_id: USER_ID,
    morning_agenda_enabled: 1,
    morning_agenda_time: '08:00',
    morning_agenda_format: 'text',
    default_reminder_intervals: '[30, 0]',
    evening_review_enabled: 0,
    evening_review_time: '21:00',
    evening_review_format: 'text',
    quiet_hours_enabled: 0,
    quiet_hours_start: null,
    quiet_hours_end: null,
    updated_at: STORED_AT,
    ...overrides,
  };
}

function callSettingsRow(overrides: Partial<UserCallSettings> = {}): UserCallSettings {
  return {
    user_id: USER_ID,
    enabled: 0,
    quiet_hours_start: null,
    quiet_hours_end: null,
    max_daily_calls: 5,
    language: 'en',
    important_only: 0,
    updated_at: STORED_AT,
    ...overrides,
  };
}

function sharingSettingsRow(overrides: Partial<SharingSettings> = {}): SharingSettings {
  return {
    user_id: USER_ID,
    default_visibility: 'private',
    inline_mode_enabled: 1,
    allow_invitations: 1,
    share_location: 0,
    share_description: 0,
    updated_at: STORED_AT,
    ...overrides,
  };
}

interface RepoLog {
  calls: string[];
}

function notificationsWith(log: RepoLog, prefs: NotificationPreferencesRow): NotificationsCapability {
  return {
    notificationPrefs: {
      ensureDefaults: (id) => {
        log.calls.push(`notif.ensureDefaults:${id}`);
      },
      getPrefs: (id) => {
        log.calls.push(`notif.getPrefs:${id}`);
        return prefs;
      },
      update: (id, patch) => {
        log.calls.push(`notif.update:${id}:${JSON.stringify(patch)}`);
      },
    },
  };
}

function callsWith(log: RepoLog, row: UserCallSettings | null): CallsCapability {
  return partialOf<CallsCapability>('calls', {
    callSettingsRepo: partialOf<CallsCapability['callSettingsRepo']>('callSettingsRepo', {
      ensureDefaults: (id) => {
        log.calls.push(`calls.ensureDefaults:${id}`);
      },
      get: (id) => {
        log.calls.push(`calls.get:${id}`);
        return row;
      },
    }),
  });
}

function sharingWith(log: RepoLog, row: SharingSettings | null): SharingCapability {
  return partialOf<SharingCapability>('sharing', {
    sharingSettingsRepo: partialOf<SharingSettingsRepository>('sharingSettingsRepo', {
      ensureDefaults: (id) => {
        log.calls.push(`sharing.ensureDefaults:${id}`);
      },
      get: (id) => {
        log.calls.push(`sharing.get:${id}`);
        return row;
      },
    }),
  });
}

describe('manage_settings get: single categories', () => {
  test('general defaults unset profile fields', () => {
    const result = handleManageSettings(makeCtx({ user: userWithNullDuration() }), {
      action: 'get',
      category: 'general',
    });
    expect(result).toEqual({
      success: true,
      output: JSON.stringify({
        timezone: 'Europe/Kyiv',
        language: 'en',
        username: 'not set',
        first_name: 'not set',
        country_code: 'not set',
        default_event_duration_minutes: 60,
      }),
    });
  });

  test('notifications are ensured then read from the prefs repo', () => {
    const log: RepoLog = { calls: [] };
    const prefs = notificationPrefsRow({ morning_agenda_enabled: 1 });
    const ctx = makeCtx({ notifications: notificationsWith(log, prefs) });
    const result = handleManageSettings(ctx, { action: 'get', category: 'notifications' });
    expect(result).toEqual({ success: true, output: JSON.stringify(prefs) });
    expect(log.calls).toEqual([`notif.ensureDefaults:${USER_ID}`, `notif.getPrefs:${USER_ID}`]);
  });

  test('notifications without a prefs repo yield an empty object', () => {
    expect(handleManageSettings(makeCtx(), { action: 'get', category: 'notifications' })).toEqual({
      success: true,
      output: '{}',
    });
  });

  test('calls strip user_id and updated_at', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ calls: callsWith(log, callSettingsRow({ enabled: 1, language: 'ru' })) });
    const result = handleManageSettings(ctx, { action: 'get', category: 'calls' });
    expect(result).toEqual({
      success: true,
      output:
        '{"enabled":1,"quiet_hours_start":null,"quiet_hours_end":null,"max_daily_calls":5,"language":"ru","important_only":0}',
    });
    expect(log.calls).toEqual([`calls.ensureDefaults:${USER_ID}`, `calls.get:${USER_ID}`]);
  });

  test('calls with no stored row yield an empty object', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ calls: callsWith(log, null) });
    expect(handleManageSettings(ctx, { action: 'get', category: 'calls' })).toEqual({ success: true, output: '{}' });
  });

  test('calls without a calling account fail with the unavailable hint', () => {
    const result = handleManageSettings(makeCtx(), { action: 'get', category: 'calls' });
    expect(result.success).toBe(false);
    expect(result.agentHint).toBe(
      'This bot has no calling account, so voice calls cannot be enabled or configured by any setting.',
    );
  });

  test('privacy strips user_id and updated_at', () => {
    const log: RepoLog = { calls: [] };
    const row = sharingSettingsRow({ default_visibility: 'private', inline_mode_enabled: 0 });
    const ctx = makeCtx({ sharing: sharingWith(log, row) });
    const result = handleManageSettings(ctx, { action: 'get', category: 'privacy' });
    expect(result).toEqual({
      success: true,
      output:
        '{"default_visibility":"private","inline_mode_enabled":0,"allow_invitations":1,"share_location":0,"share_description":0}',
    });
    expect(log.calls).toEqual([`sharing.ensureDefaults:${USER_ID}`, `sharing.get:${USER_ID}`]);
  });

  test('privacy without a sharing repo or a stored row yields an empty object', () => {
    expect(handleManageSettings(makeCtx(), { action: 'get', category: 'privacy' })).toEqual({
      success: true,
      output: '{}',
    });
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ sharing: sharingWith(log, null) });
    expect(handleManageSettings(ctx, { action: 'get', category: 'privacy' })).toEqual({ success: true, output: '{}' });
  });

  test('voice reports the stored flag', () => {
    const ctx = makeCtx();
    ctx.user.voice_response_enabled = 1;
    expect(handleManageSettings(ctx, { action: 'get', category: 'voice' })).toEqual({
      success: true,
      output: '{"voice_response_enabled":1}',
    });
  });
});

describe('manage_settings get: no category', () => {
  test('without optional repos only general and voice are present, in that order', () => {
    const result = handleManageSettings(makeCtx(), { action: 'get' });
    expect(Object.keys(JSON.parse(result.output ?? '{}'))).toEqual(['general', 'voice']);
  });

  test('with every repo present all five sections appear in a fixed order', () => {
    const log: RepoLog = { calls: [] };
    const prefs = notificationPrefsRow({ morning_agenda_enabled: 0 });
    const ctx = makeCtx({
      notifications: notificationsWith(log, prefs),
      calls: callsWith(log, callSettingsRow({ enabled: 0 })),
      sharing: sharingWith(log, sharingSettingsRow({ allow_invitations: 1 })),
    });
    const result = handleManageSettings(ctx, { action: 'get' });
    const data = JSON.parse(result.output ?? '{}');
    expect(Object.keys(data)).toEqual(['general', 'notifications', 'calls', 'privacy', 'voice']);
    expect(data.notifications).toEqual(prefs);
    expect(data.calls).toEqual({
      enabled: 0,
      quiet_hours_start: null,
      quiet_hours_end: null,
      max_daily_calls: 5,
      language: 'en',
      important_only: 0,
    });
    expect(data.privacy).toEqual({
      default_visibility: 'private',
      inline_mode_enabled: 1,
      allow_invitations: 1,
      share_location: 0,
      share_description: 0,
    });
    expect(data.voice).toEqual({ voice_response_enabled: null });
  });
});

describe('manage_settings update notifications patch', () => {
  test('maps booleans to 0/1, passes times through and JSON-encodes reminder minutes', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ notifications: notificationsWith(log, notificationPrefsRow()) });
    const result = handleManageSettings(ctx, {
      action: 'update',
      category: 'notifications',
      updates: {
        morning_agenda_enabled: true,
        morning_agenda_time: '08:00',
        evening_review_enabled: false,
        evening_review_time: '21:30',
        quiet_hours_enabled: true,
        quiet_hours_start: '23:00',
        quiet_hours_end: null,
        default_reminder_minutes: [10, 60],
      },
    });
    expect(result.success).toBe(true);
    expect(log.calls[0]).toBe(`notif.ensureDefaults:${USER_ID}`);
    expect(JSON.parse(log.calls[1]?.slice(`notif.update:${USER_ID}:`.length) ?? 'null')).toEqual({
      morning_agenda_enabled: 1,
      morning_agenda_time: '08:00',
      evening_review_enabled: 0,
      evening_review_time: '21:30',
      quiet_hours_enabled: 1,
      quiet_hours_start: '23:00',
      quiet_hours_end: null,
      default_reminder_intervals: '[10,60]',
    });
  });

  test('an update carrying no known field is rejected without writing', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ notifications: notificationsWith(log, notificationPrefsRow()) });
    // Tool-call arguments arrive as JSON text; a field outside the declared patch reaches the handler
    // through JSON.parse, whose `any` result is the untrusted boundary assigned to the parameter type.
    const updates: NotificationUpdatesInput = JSON.parse('{"unknown_field":true}');
    const result = handleManageSettings(ctx, { action: 'update', category: 'notifications', updates });
    expect(result).toEqual({ success: false, error: 'No notification settings provided.' });
    expect(log.calls).toEqual([`notif.ensureDefaults:${USER_ID}`]);
  });

  test('without a prefs repo the update fails before touching anything', () => {
    const result = handleManageSettings(makeCtx(), {
      action: 'update',
      category: 'notifications',
      updates: { morning_agenda_enabled: true },
    });
    expect(result).toEqual({ success: false, error: 'Notification settings not configured.' });
  });
});
