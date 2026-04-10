// test/services/ai/tool-handlers/attach-pending-location.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleAttachPendingLocationToEvent } from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(overrides: { [key: string]: unknown } = {}): AgentContext {
  return {
    user: {
      telegram_id: 100,
      language: 'en',
      timezone: 'UTC',
      first_name: 'Test',
      username: null,
      country_code: null,
      google_refresh_token_enc: null,
      google_calendar_id: null,
      onboarding_completed: 1,
      timezone_updated_at: null,
      voice_response_enabled: null,
      default_event_duration_minutes: 60,
      assistant_enabled: 0,
      city: null,
      created_at: '',
      updated_at: '',
    },
    locationVerification: {
      resolveFromCoordinates: mock(() => Promise.resolve(true)),
    },
    pendingGeoStore: {
      get: mock(() => Promise.resolve({ latitude: 55.75, longitude: 37.6 })),
      delete: mock(() => Promise.resolve()),
      set: mock(() => Promise.resolve()),
    },
    ...overrides,
  } as unknown as AgentContext;
}

describe('handleAttachPendingLocationToEvent', () => {
  test('attaches pending pin to event and clears the store', async () => {
    const ctx = makeCtx();
    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 42 });

    expect(result.success).toBe(true);
    expect(ctx.locationVerification!.resolveFromCoordinates).toHaveBeenCalledWith(42, 55.75, 37.6, 100);
    expect(ctx.pendingGeoStore!.delete).toHaveBeenCalledWith(100);
  });

  test('returns error when no pending pin exists', async () => {
    const ctx = makeCtx({
      pendingGeoStore: {
        get: mock(() => Promise.resolve(null)),
        delete: mock(() => Promise.resolve()),
        set: mock(() => Promise.resolve()),
      },
    });

    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 42 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No pending location pin');
    expect(ctx.locationVerification!.resolveFromCoordinates).not.toHaveBeenCalled();
  });

  test('returns error when locationVerification is not available', async () => {
    const ctx = makeCtx({ locationVerification: undefined });

    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 42 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  test('returns error when pendingGeoStore is not available', async () => {
    const ctx = makeCtx({ pendingGeoStore: undefined });

    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 42 });

    expect(result.success).toBe(false);
  });

  test('returns error when resolveFromCoordinates fails (event not found)', async () => {
    const ctx = makeCtx({
      locationVerification: {
        resolveFromCoordinates: mock(() => Promise.resolve(false)),
      },
    });

    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 999 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('999');
    // Pending pin NOT cleared on failure (user can retry with different event)
    expect(ctx.pendingGeoStore!.delete).not.toHaveBeenCalled();
  });

  test('produces Russian output for ru users', async () => {
    const ctx = makeCtx({
      user: { telegram_id: 100, language: 'ru' },
    });

    const result = await handleAttachPendingLocationToEvent(ctx, { event_id: 42 });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Локация');
  });
});
