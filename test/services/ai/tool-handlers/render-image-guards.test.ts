// Characterization tests for the shared guards and failure mapping of the day/week/month image handlers:
// secretary access denial, invalid dates, group-scope requirements, typed agenda-image errors and
// unexpected render failures reported with the localized fallback text.
import { describe, expect, mock, test } from 'bun:test';
import { t } from '../../../../src/config/constants.ts';
import type { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import {
  handleRenderDayImage,
  handleRenderMonthImage,
  handleRenderWeekImage,
} from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { AgendaImageError } from '../../../../src/utils/agenda-image.ts';
import { png } from '../../../fixtures/png.ts';
import { partialOf } from '../partial-stubs.ts';

const meta = t('en').aiTools.meta;

function makeCtx(renderDirect: () => Promise<Uint8Array> = () => Promise.resolve(png()), overrides = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'en', timezone: 'UTC' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    },
    renderService: { renderDirect: mock(renderDirect) },
    eventService: {
      getEventsForDay: mock(() => []),
      getEventsInRange: mock(() => []),
      getEventsInRangeForGroup: mock(() => []),
    },
    userRepo: partialOf<UserRepository>('userRepo'),
    holidayService: undefined,
    ...overrides,
  } as unknown as AgentContext;
}

const handlers = [
  ['day', (ctx: AgentContext, extra = {}) => handleRenderDayImage(ctx, { date: '2026-04-07', ...extra })],
  ['week', (ctx: AgentContext, extra = {}) => handleRenderWeekImage(ctx, { week_start: '2026-04-06', ...extra })],
  ['month', (ctx: AgentContext, extra = {}) => handleRenderMonthImage(ctx, { month: '2026-04', ...extra })],
] as const;

describe.each(handlers)('%s image handler guards', (_name, run) => {
  test('unavailable renderer or sender is reported first', async () => {
    const noRenderer = await run(makeCtx(undefined, { renderService: undefined }));
    expect(noRenderer).toEqual({ success: false, error: 'Image rendering not available.' });
    const noPhoto = await run(makeCtx(undefined, { sender: {} }));
    expect(noPhoto).toEqual({ success: false, error: 'Image rendering not available.' });
  });

  test('owner_id without secretary access is denied', async () => {
    const result = await run(makeCtx(), { owner_id: 55 });
    expect(result).toEqual({ success: false, error: 'SECRETARY_ACCESS_DENIED' });
  });

  test('inactive secretary link is denied; an active one renders for the owner', async () => {
    const inactive = makeCtx(undefined, {
      secretary: { secretaryRepo: { findByOwnerAndSecretary: () => ({ status: 'pending', permission: 'read' }) } },
    });
    expect(await run(inactive, { owner_id: 55 })).toEqual({ success: false, error: 'SECRETARY_ACCESS_DENIED' });

    const active = makeCtx(undefined, {
      secretary: { secretaryRepo: { findByOwnerAndSecretary: () => ({ status: 'active', permission: 'read' }) } },
    });
    const result = await run(active, { owner_id: 55 });
    expect(result.success).toBe(true);
  });

  test('group scope without a group chat is rejected', async () => {
    const result = await run(makeCtx(), { scope: 'group' });
    expect(result).toEqual({ success: false, error: 'Group context required for group scope' });
  });

  test('typed agenda image errors are surfaced verbatim', async () => {
    const ctx = makeCtx(() => Promise.reject(new AgendaImageError('too tall')));
    expect(await run(ctx)).toEqual({ success: false, error: 'too tall' });
  });

  test('unexpected render failures use the localized fallback text', async () => {
    const ctx = makeCtx(() => Promise.reject(new Error('playwright down')));
    const result = await run(ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('playwright down');
  });
});

describe('handleRenderDayImage specifics', () => {
  test('invalid calendar date is rejected before any lookup', async () => {
    const ctx = makeCtx();
    const result = await handleRenderDayImage(ctx, { date: '2026-02-30' });
    expect(result).toEqual({ success: false, error: 'Invalid calendar date.' });
    expect(ctx.eventService.getEventsForDay).not.toHaveBeenCalled();
  });

  test('group scope queries the group range for the local day', async () => {
    const ctx = makeCtx(undefined, { groupChatId: -100 });
    const result = await handleRenderDayImage(ctx, { date: '2026-04-07', scope: 'group' });
    expect(result.success).toBe(true);
    expect(ctx.eventService.getEventsInRangeForGroup).toHaveBeenCalledWith(
      -100,
      '2026-04-07T00:00:00.000Z',
      '2026-04-07T23:59:59.999Z',
    );
    expect(ctx.eventService.getEventsForDay).not.toHaveBeenCalled();
  });

  test('success output names the date and tells the model not to re-render', async () => {
    const result = await handleRenderDayImage(makeCtx(), { date: '2026-04-07' });
    expect(result.output).toBe(meta.dayImageSent('2026-04-07'));
    expect(result.agentHint).toBe(
      'The day image has already been delivered to the chat. Do NOT call render_day_image again for this date in this turn.',
    );
  });

  test('fallback failure text names the requested date', async () => {
    const result = await handleRenderDayImage(
      makeCtx(() => Promise.reject(new Error('boom'))),
      { date: '2026-04-07' },
    );
    expect(result.error).toBe(meta.dayImageFailed('2026-04-07'));
  });
});

describe('handleRenderWeekImage specifics', () => {
  test('fallback failure text names the requested week_start', async () => {
    const result = await handleRenderWeekImage(
      makeCtx(() => Promise.reject(new Error('boom'))),
      { week_start: '2026-04-08' },
    );
    expect(result.error).toBe(meta.weekImageFailed('2026-04-08'));
  });

  test('malformed or overflowing week_start is rejected with the localized failure text', async () => {
    for (const week_start of ['2026-4-7', 'next monday', '2026-13-01', '2026-02-30']) {
      const result = await handleRenderWeekImage(makeCtx(), { week_start });
      expect(result).toEqual({ success: false, error: meta.weekImageFailed(week_start) });
    }
  });

  test('group scope queries the group range of the Monday-based week', async () => {
    const ctx = makeCtx(undefined, { groupChatId: -100 });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-08', scope: 'group' });
    expect(result.success).toBe(true);
    expect(ctx.eventService.getEventsInRangeForGroup).toHaveBeenCalledWith(
      -100,
      '2026-04-06T00:00:00.000Z',
      '2026-04-12T23:59:59.999Z',
    );
  });
});

describe('handleRenderMonthImage specifics', () => {
  test('fallback failure text names the requested month', async () => {
    const result = await handleRenderMonthImage(
      makeCtx(() => Promise.reject(new Error('boom'))),
      { month: '2026-04' },
    );
    expect(result.error).toBe(meta.monthImageFailed('2026-04'));
  });
});
