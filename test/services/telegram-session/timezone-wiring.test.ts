import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import type { TelegramSession } from '../../../src/database/types.ts';
import {
  type ConnectedUserSenderDeps,
  checkTimezoneOpportunistically,
} from '../../../src/services/telegram-session/connected-user-sender.ts';
import type { BridgeResult } from '../../../src/services/telegram-session/session-bridge.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

const MASTER_KEY = Buffer.alloc(32, 0xab);
const SESSION_DATA = Buffer.from('fake-session-data');

function makeMockSessionRepo(
  session: Partial<TelegramSession> | null,
): TelegramSessionRepository & { getActive: ReturnType<typeof mock> } {
  return {
    getActive: mock((_userId: number) => {
      if (!session) return null;
      return {
        user_id: 100,
        encrypted_session: Buffer.from('enc'),
        phone_masked: '+7 ••• 0000',
        phone_hash: 'abc',
        status: 'active' as const,
        tz_detection_consent_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        ...session,
      };
    }),
    updateStatus: mock(() => {}),
    setTzConsentAt: mock(() => {}),
  } as unknown as TelegramSessionRepository & { getActive: ReturnType<typeof mock> };
}

const originalCreateTemp = SessionBridge.createTempSessionFile;
const originalGetAuthorizations = SessionBridge.getAuthorizations;
const originalCleanup = SessionBridge.cleanupTempFile;

describe('checkTimezoneOpportunistically', () => {
  beforeEach(() => {
    SessionBridge.createTempSessionFile = mock(async () => '/tmp/tgsess_tz_test.session');
    SessionBridge.cleanupTempFile = mock(async () => {});
  });

  afterEach(() => {
    SessionBridge.createTempSessionFile = originalCreateTemp;
    SessionBridge.getAuthorizations = originalGetAuthorizations;
    SessionBridge.cleanupTempFile = originalCleanup;
  });

  test('calls onTzConsentNeeded when tz_detection_consent_at is null', async () => {
    const sessionRepo = makeMockSessionRepo({ tz_detection_consent_at: null });
    const onTimezoneDetected = mock(() => {});
    const onTzConsentNeeded = mock(() => {});
    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected,
      onTzConsentNeeded,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTzConsentNeeded).toHaveBeenCalledWith(100);
    expect(onTimezoneDetected).not.toHaveBeenCalled();
    // Should not create a temp file — consent not yet given
    expect(SessionBridge.createTempSessionFile).not.toHaveBeenCalled();
  });

  test('does not call onTzConsentNeeded when already asked within 24h', async () => {
    const sessionRepo = makeMockSessionRepo({ tz_detection_consent_at: null });
    const onTzConsentNeeded = mock(() => {});
    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTzConsentNeeded,
    };

    // First call — should ask
    await checkTimezoneOpportunistically(deps, 200, SESSION_DATA);
    expect(onTzConsentNeeded).toHaveBeenCalledTimes(1);

    // Second call within the cooldown window — should not ask again
    await checkTimezoneOpportunistically(deps, 200, SESSION_DATA);
    expect(onTzConsentNeeded).toHaveBeenCalledTimes(1);
  });

  test('skips silently when tz_detection_consent_at is null and no onTzConsentNeeded handler', async () => {
    const sessionRepo = makeMockSessionRepo({ tz_detection_consent_at: null });
    const onTimezoneDetected = mock(() => {});
    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).not.toHaveBeenCalled();
    expect(SessionBridge.createTempSessionFile).not.toHaveBeenCalled();
  });

  test('skips when consent is "never"', async () => {
    const sessionRepo = makeMockSessionRepo({ tz_detection_consent_at: 'never' });
    const onTimezoneDetected = mock(() => {});
    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).not.toHaveBeenCalled();
    expect(SessionBridge.createTempSessionFile).not.toHaveBeenCalled();
  });

  test('calls onTimezoneDetected when timezone differs', async () => {
    const sessionRepo = makeMockSessionRepo({
      tz_detection_consent_at: '2026-01-15 10:00:00',
    });
    const onTimezoneDetected = mock(() => {});

    const authResult: BridgeResult = {
      success: true,
      data: {
        authorizations: [
          {
            hash: 1,
            device_model: 'iPhone',
            platform: 'iOS',
            system_version: '17.0',
            app_name: 'Telegram',
            country: 'RS',
            region: 'Belgrade',
            ip: '1.2.3.4',
            date_active: Math.floor(Date.now() / 1000),
            current: false,
          },
        ],
      },
    };
    SessionBridge.getAuthorizations = mock(async () => authResult);

    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      getUserTimezone: () => 'America/New_York',
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).toHaveBeenCalledWith(100, {
      detectedTimezone: 'Europe/Belgrade',
      country: 'RS',
      region: 'Belgrade',
    });
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalledWith('/tmp/tgsess_tz_test.session');
  });

  test('does not call onTimezoneDetected when timezone matches', async () => {
    const sessionRepo = makeMockSessionRepo({
      tz_detection_consent_at: '2026-01-15 10:00:00',
    });
    const onTimezoneDetected = mock(() => {});

    const authResult: BridgeResult = {
      success: true,
      data: {
        authorizations: [
          {
            hash: 1,
            device_model: 'iPhone',
            platform: 'iOS',
            system_version: '17.0',
            app_name: 'Telegram',
            country: 'RS',
            region: 'Belgrade',
            ip: '1.2.3.4',
            date_active: Math.floor(Date.now() / 1000),
            current: false,
          },
        ],
      },
    };
    SessionBridge.getAuthorizations = mock(async () => authResult);

    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      getUserTimezone: () => 'Europe/Belgrade',
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).not.toHaveBeenCalled();
  });

  test('does not call onTimezoneDetected when getAuthorizations fails', async () => {
    const sessionRepo = makeMockSessionRepo({
      tz_detection_consent_at: '2026-01-15 10:00:00',
    });
    const onTimezoneDetected = mock(() => {});

    const authResult: BridgeResult = {
      success: false,
      error: 'SESSION_EXPIRED',
      message: 'Session expired',
    };
    SessionBridge.getAuthorizations = mock(async () => authResult);

    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).not.toHaveBeenCalled();
  });

  test('cleans up temp file even when detection throws', async () => {
    const sessionRepo = makeMockSessionRepo({
      tz_detection_consent_at: '2026-01-15 10:00:00',
    });

    SessionBridge.getAuthorizations = mock(async () => {
      throw new Error('bridge crashed');
    });

    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected: mock(() => {}),
    };

    await expect(checkTimezoneOpportunistically(deps, 100, SESSION_DATA)).rejects.toThrow('bridge crashed');
    expect(SessionBridge.cleanupTempFile).toHaveBeenCalledWith('/tmp/tgsess_tz_test.session');
  });

  test('skips when no active session found', async () => {
    const sessionRepo = makeMockSessionRepo(null);
    const onTimezoneDetected = mock(() => {});
    const deps: ConnectedUserSenderDeps = {
      sessionRepo,
      masterKey: MASTER_KEY,
      onTimezoneDetected,
    };

    await checkTimezoneOpportunistically(deps, 100, SESSION_DATA);

    expect(onTimezoneDetected).not.toHaveBeenCalled();
  });
});
