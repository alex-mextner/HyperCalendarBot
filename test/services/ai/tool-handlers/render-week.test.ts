import { describe, expect, mock, test } from 'bun:test';
import { handleRenderWeekImage } from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { png } from '../../../fixtures/png.ts';

function makeCtx(
  overrides: Omit<Partial<AgentContext>, 'user'> & { user?: Partial<AgentContext['user']> } = {},
): AgentContext {
  const { user: userOverrides, ...rest } = overrides;
  return {
    user: { telegram_id: 1, language: 'ru', timezone: 'Europe/Moscow', ...userOverrides },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    },
    renderService: {
      renderDirect: mock(() => Promise.resolve(png())),
    },
    eventService: {
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    },
    userRepo: {} as never,
    holidayService: {} as never,
    ...rest,
  } as Partial<AgentContext> as AgentContext;
}

describe('handleRenderWeekImage', () => {
  test('returns success after render + send photo', async () => {
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  test('output contains week start date and past-tense marker', async () => {
    const ctx = makeCtx();
    // 2026-04-06 is Monday
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-06' });
    expect(result.output).toContain('2026-04-06');
    expect(result.output).toContain('отправлена');
  });

  test('sendPhoto is awaited before handler returns', async () => {
    const sendPhoto = mock(() => Promise.resolve({ message_id: 42 }));
    const ctx = makeCtx({
      sender: {
        sendPhoto,
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
      } as never,
    });
    await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('agentHint instructs the model not to retry', async () => {
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.agentHint).toBeDefined();
    expect(result.agentHint!).toContain('Do NOT call render_week_image again');
  });

  test('fails when renderService missing', async () => {
    const ctx = makeCtx({ renderService: undefined });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when sendPhoto missing', async () => {
    const ctx = makeCtx({ sender: {} as never });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
  });

  test('fails when group scope but no groupChatId', async () => {
    const ctx = makeCtx({ groupChatId: undefined, isGroup: false });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    expect(result.success).toBe(false);
  });

  test('calls getEventsInRangeForGroup when scope is group', async () => {
    const getEventsInRangeForGroup = mock(() => []);
    const ctx = makeCtx({
      isGroup: true,
      groupChatId: 100,
      eventService: { getEventsInRange: mock(() => []), getEventsInRangeForGroup } as never,
    });
    await handleRenderWeekImage(ctx, { week_start: '2026-04-07', scope: 'group' });
    expect(getEventsInRangeForGroup).toHaveBeenCalled();
  });

  test('render failure returns success:false with error message', async () => {
    const ctx = makeCtx({
      renderService: {
        renderDirect: mock(() => Promise.reject(new Error('playwright down'))),
      },
    });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-07' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('normalizes non-Monday week_start to Monday of same week', async () => {
    // 2026-04-28 is Tuesday; Monday of that week is 2026-04-27
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-28' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('2026-04-27');
    expect(result.output).not.toContain('2026-04-28');
  });

  test('normalizes Sunday week_start in UTC+13 zone to the same week Monday, not next week', async () => {
    // 2026-01-04 is a Sunday. Anchoring the parse at UTC noon before converting to the user's
    // timezone shifts the local calendar day forward past midnight in Pacific/Auckland (UTC+13),
    // turning the Sunday input into local Monday and resolving to the WRONG (next) week's Monday.
    // The correct Monday for the week containing 2026-01-04 is 2025-12-29.
    const ctx = makeCtx({ user: { telegram_id: 1, language: 'ru', timezone: 'Pacific/Auckland' } });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-01-04' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('2025-12-29');
    expect(result.output).not.toContain('2026-01-05');
  });

  test('rejects a malformed week_start with an empty date segment', async () => {
    // "2026--04" split on '-' used to yield an empty month segment; Number('') is 0, which
    // Number.isFinite(0) accepted, silently rendering the wrong week instead of failing.
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026--04' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('rejects a week_start with an out-of-range month', async () => {
    // Month 13 used to silently roll over into January of the next year instead of failing.
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-13-01' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('rejects a week_start with a day that overflows its month', async () => {
    // February never has 30 days; it used to silently roll over into March.
    const ctx = makeCtx();
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-02-30' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('event query range uses timezone-local week boundaries', async () => {
    // makeCtx default timezone is Europe/Moscow (UTC+3, no DST)
    // Monday midnight Moscow = Sunday 21:00 UTC; events before UTC midnight are captured
    const getEventsInRange = mock(() => []);
    const ctx = makeCtx({
      eventService: {
        getEventsInRange,
        getEventsInRangeForGroup: mock(() => []),
      } as unknown as AgentContext['eventService'],
    });
    await handleRenderWeekImage(ctx, { week_start: '2026-04-27' });
    expect(getEventsInRange).toHaveBeenCalledTimes(1);
    const callArgs = getEventsInRange.mock.calls[0] as unknown as [number, string, string];
    // Must start at Moscow Monday midnight = UTC Sunday 21:00, not UTC midnight
    expect(callArgs[1]).toBe('2026-04-26T21:00:00.000Z');
    expect(callArgs[2]).toBe('2026-05-03T20:59:59.999Z');
  });
});
