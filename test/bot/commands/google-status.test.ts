// test/bot/commands/google-status.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { formatSyncAge, handleGoogleStatus } from '../../../src/bot/commands/google-status.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { GoogleCalendarRepository } from '../../../src/database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../../src/database/repositories/google-sync.repository.ts';
import type { GoogleCalendar, GoogleSyncState, User } from '../../../src/database/types.ts';

// ─── Factories ───────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  return {
    telegram_id: 1,
    username: 'testuser',
    first_name: 'Test',
    language: 'en',
    timezone: 'UTC',
    country_code: null,
    google_refresh_token_enc: 'encrypted',
    google_calendar_id: null,
    onboarding_completed: 1,
    timezone_updated_at: null,
    voice_response_enabled: null,
    default_event_duration_minutes: 30,
    assistant_enabled: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeSyncState(overrides: Partial<GoogleSyncState> = {}): GoogleSyncState {
  return {
    user_id: 1,
    access_token: 'tok',
    expires_at: null,
    scopes: 'calendar',
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function makeCalendar(overrides: Partial<GoogleCalendar> = {}): GoogleCalendar {
  return {
    id: 1,
    user_id: 1,
    google_calendar_id: 'primary',
    calendar_name: 'My Calendar',
    color: '#d50000',
    is_primary: 1,
    sync_enabled: 1,
    access_role: 'owner',
    sync_token: 'tok',
    last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const mockSend = mock(async () => ({}));
const mockGetSyncState = mock((): GoogleSyncState | null => null);
const mockGetCalendars = mock((): GoogleCalendar[] => []);

function makeCtx(overrides: Partial<BotCommandContext> = {}): BotCommandContext {
  return {
    dbUser: makeUser(),
    chat: { type: 'private', id: 1 },
    send: mockSend,
    ...overrides,
  } as unknown as BotCommandContext;
}

function makeDeps() {
  const syncRepo = { getSyncState: mockGetSyncState } as unknown as GoogleSyncRepository;
  const calendarRepo = { getCalendars: mockGetCalendars } as unknown as GoogleCalendarRepository;
  return { syncRepo, calendarRepo };
}

// ─── formatSyncAge tests ──────────────────────────────────────────────────────

describe('formatSyncAge', () => {
  test('null → not yet (en)', () => {
    expect(formatSyncAge(null, 'en')).toBe('not yet');
  });

  test('null → ещё нет (ru)', () => {
    expect(formatSyncAge(null, 'ru')).toBe('ещё нет');
  });

  test('< 1 min → just now (en)', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatSyncAge(iso, 'en')).toBe('just now');
  });

  test('< 1 min → только что (ru)', () => {
    const iso = new Date(Date.now() - 30_000).toISOString();
    expect(formatSyncAge(iso, 'ru')).toBe('только что');
  });

  test('30 min ago → 30 min (en)', () => {
    const iso = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'en')).toBe('30 min');
  });

  test('30 min ago → 30 мин (ru)', () => {
    const iso = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'ru')).toBe('30 мин');
  });

  test('2 hr ago → 2 hr (en)', () => {
    const iso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'en')).toBe('2 hr');
  });

  test('2 hr ago → 2 ч (ru)', () => {
    const iso = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'ru')).toBe('2 ч');
  });

  test('3 days ago → 3 d (en)', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'en')).toBe('3 d');
  });

  test('3 days ago → 3 д (ru)', () => {
    const iso = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    expect(formatSyncAge(iso, 'ru')).toBe('3 д');
  });
});

// ─── handleGoogleStatus tests ─────────────────────────────────────────────────

describe('handleGoogleStatus', () => {
  test('group chat: returns without sending', async () => {
    mockSend.mockClear();
    const ctx = makeCtx({ chat: { type: 'supergroup', id: -100 } } as Partial<BotCommandContext>);
    await handleGoogleStatus(ctx, makeDeps());
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('no dbUser: returns without sending', async () => {
    mockSend.mockClear();
    const ctx = makeCtx({ dbUser: undefined } as Partial<BotCommandContext>);
    await handleGoogleStatus(ctx, makeDeps());
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('no sync state: shows not-connected message', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(null);
    const ctx = makeCtx();
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('not connected');
  });

  test('revoked status: shows revoked message', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(makeSyncState({ status: 'revoked' }));
    const ctx = makeCtx();
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('connect_google');
  });

  test('connected, no calendars: shows header + no calendars message', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(makeSyncState());
    mockGetCalendars.mockReturnValueOnce([]);
    const ctx = makeCtx();
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('Google Calendar');
    expect(text).toContain('Connected');
    expect(text).toContain('No calendars');
  });

  test('connected with calendars: shows calendar names and sync info', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(makeSyncState());
    mockGetCalendars.mockReturnValueOnce([
      makeCalendar({ calendar_name: 'My Calendar', is_primary: 1, sync_enabled: 1 }),
      makeCalendar({
        id: 2,
        calendar_name: 'Work',
        google_calendar_id: 'work@group.calendar.google.com',
        is_primary: 0,
        sync_enabled: 0,
      }),
    ]);
    const ctx = makeCtx();
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('My Calendar');
    expect(text).toContain('Work');
    expect(text).toContain('★');
    expect(text).toContain('disabled');
    // enabled calendar has sync age (5 min)
    expect(text).toContain('min');
  });

  test('connected with calendars: shows color dot for known color', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(makeSyncState());
    mockGetCalendars.mockReturnValueOnce([makeCalendar({ color: '#d50000' })]);
    const ctx = makeCtx();
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('🔴');
  });

  test('ru language: shows Russian strings', async () => {
    mockSend.mockClear();
    mockGetSyncState.mockReturnValueOnce(makeSyncState());
    mockGetCalendars.mockReturnValueOnce([makeCalendar({ sync_enabled: 0 })]);
    const ctx = makeCtx({ dbUser: makeUser({ language: 'ru' }) } as Partial<BotCommandContext>);
    await handleGoogleStatus(ctx, makeDeps());
    const [text] = mockSend.mock.calls[0] as unknown as [string];
    expect(text).toContain('Подключён');
    expect(text).toContain('отключён');
  });
});
