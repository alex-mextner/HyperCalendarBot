// Pins manage_settings `get` (every category and the no-category aggregate) and the
// notifications `update` patch, so handleGet/updateNotifications can be split into
// per-category helpers without changing the tool-result JSON or error text.
import { describe, expect, test } from 'bun:test';
import { handleManageSettings } from '../../../src/services/ai/tool-handlers/settings.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

const USER_ID = 7;

function makeCtx(extra: Partial<AgentContext> = {}): AgentContext {
  return {
    user: {
      telegram_id: USER_ID,
      timezone: 'Europe/Kyiv',
      language: 'en',
      username: null,
      first_name: null,
      country_code: null,
      default_event_duration_minutes: null,
      voice_response_enabled: null,
    },
    chatId: USER_ID,
    messageText: '',
    isGroup: false,
    ...extra,
  } as unknown as AgentContext;
}

interface RepoLog {
  calls: string[];
}

function notificationPrefsStub(log: RepoLog, prefs: Record<string, unknown>) {
  return {
    ensureDefaults: (id: number) => log.calls.push(`notif.ensureDefaults:${id}`),
    getPrefs: (id: number) => {
      log.calls.push(`notif.getPrefs:${id}`);
      return prefs;
    },
    update: (id: number, patch: Record<string, unknown>) => {
      log.calls.push(`notif.update:${id}:${JSON.stringify(patch)}`);
    },
  };
}

function settingsRepoStub(prefix: string, log: RepoLog, row: Record<string, unknown> | undefined) {
  return {
    ensureDefaults: (id: number) => log.calls.push(`${prefix}.ensureDefaults:${id}`),
    get: (id: number) => {
      log.calls.push(`${prefix}.get:${id}`);
      return row;
    },
  };
}

describe('manage_settings get: single categories', () => {
  test('general defaults unset profile fields', () => {
    const result = handleManageSettings(makeCtx(), { action: 'get', category: 'general' });
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
    const ctx = makeCtx({
      notifications: { notificationPrefs: notificationPrefsStub(log, { morning_agenda_enabled: 1 }) as never },
    });
    const result = handleManageSettings(ctx, { action: 'get', category: 'notifications' });
    expect(result).toEqual({ success: true, output: '{"morning_agenda_enabled":1}' });
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
    const row = { user_id: USER_ID, updated_at: 'x', enabled: 1, language: 'ru' };
    const ctx = makeCtx({ calls: { callSettingsRepo: settingsRepoStub('calls', log, row) } as never });
    const result = handleManageSettings(ctx, { action: 'get', category: 'calls' });
    expect(result).toEqual({ success: true, output: '{"enabled":1,"language":"ru"}' });
    expect(log.calls).toEqual([`calls.ensureDefaults:${USER_ID}`, `calls.get:${USER_ID}`]);
  });

  test('calls with no stored row yield an empty object', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ calls: { callSettingsRepo: settingsRepoStub('calls', log, undefined) } as never });
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
    const row = { user_id: USER_ID, updated_at: 'x', default_visibility: 'private', inline_mode_enabled: 0 };
    const ctx = makeCtx({ sharing: { sharingSettingsRepo: settingsRepoStub('sharing', log, row) } as never });
    const result = handleManageSettings(ctx, { action: 'get', category: 'privacy' });
    expect(result).toEqual({ success: true, output: '{"default_visibility":"private","inline_mode_enabled":0}' });
    expect(log.calls).toEqual([`sharing.ensureDefaults:${USER_ID}`, `sharing.get:${USER_ID}`]);
  });

  test('privacy without a sharing repo or a stored row yields an empty object', () => {
    expect(handleManageSettings(makeCtx(), { action: 'get', category: 'privacy' })).toEqual({
      success: true,
      output: '{}',
    });
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ sharing: { sharingSettingsRepo: settingsRepoStub('sharing', log, undefined) } as never });
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
    const ctx = makeCtx({
      notifications: { notificationPrefs: notificationPrefsStub(log, { morning_agenda_enabled: 0 }) as never },
      calls: { callSettingsRepo: settingsRepoStub('calls', log, { user_id: 1, updated_at: 'x', enabled: 0 }) } as never,
      sharing: {
        sharingSettingsRepo: settingsRepoStub('sharing', log, { user_id: 1, updated_at: 'x', allow_invitations: 1 }),
      } as never,
    });
    const result = handleManageSettings(ctx, { action: 'get' });
    const data = JSON.parse(result.output ?? '{}');
    expect(Object.keys(data)).toEqual(['general', 'notifications', 'calls', 'privacy', 'voice']);
    expect(data.notifications).toEqual({ morning_agenda_enabled: 0 });
    expect(data.calls).toEqual({ enabled: 0 });
    expect(data.privacy).toEqual({ allow_invitations: 1 });
    expect(data.voice).toEqual({ voice_response_enabled: null });
  });
});

describe('manage_settings update notifications patch', () => {
  test('maps booleans to 0/1, passes times through and JSON-encodes reminder minutes', () => {
    const log: RepoLog = { calls: [] };
    const ctx = makeCtx({ notifications: { notificationPrefs: notificationPrefsStub(log, {}) as never } });
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
    const ctx = makeCtx({ notifications: { notificationPrefs: notificationPrefsStub(log, {}) as never } });
    const result = handleManageSettings(ctx, {
      action: 'update',
      category: 'notifications',
      updates: { unknown_field: true } as never,
    });
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
