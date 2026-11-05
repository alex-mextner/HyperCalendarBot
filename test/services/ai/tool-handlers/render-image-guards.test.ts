// Characterization tests for the shared guards of the day/week/month image handlers (secretary access
// denial, invalid dates, group-scope requirements) and for how a failed picture reaches the user: the
// tool call only queues, so a typed agenda-image error or an unexpected render failure arrives as one
// short note in the chat, never as a failed tool call.
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
import { makeImageDelivery } from '../../../fixtures/image-delivery.ts';
import { png } from '../../../fixtures/png.ts';
import { partialOf } from '../partial-stubs.ts';

const meta = t('en').aiTools.meta;

function makeCtx(renderDirect: () => Promise<Buffer> = () => Promise.resolve(png()), overrides = {}): AgentContext {
  return {
    user: { telegram_id: 1, language: 'en', timezone: 'UTC' },
    chatId: 1,
    isGroup: false,
    sender: {
      sendPhoto: mock(() => Promise.resolve({ message_id: 42 })),
      sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    },
    imageDelivery: makeImageDelivery(renderDirect).delivery,
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
    const noRenderer = await run(makeCtx(undefined, { imageDelivery: undefined }));
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

  test('a typed agenda image error reaches the user as one localized note, never its internal English text', async () => {
    const ctx = makeCtx(() => Promise.reject(new AgendaImageError('too tall', true)));
    const result = await run(ctx);
    expect(result.success).toBe(true);
    await ctx.imageDelivery!.whenIdle();
    expect(ctx.sender!.sendPhoto).not.toHaveBeenCalled();
    expect(ctx.sender!.sendMessage).toHaveBeenCalledTimes(1);
    const note = (ctx.sender!.sendMessage as ReturnType<typeof mock>).mock.calls[0]![1] as string;
    expect(note).toContain('too large to send');
    expect(note).not.toContain('too tall');
  });

  test('a supplement turn queues no picture: it could only block or cancel a real one', async () => {
    const supplement = makeCtx(undefined, { supplementMode: true });
    const result = await run(supplement);
    expect(result.success).toBe(false);
    await supplement.imageDelivery!.whenIdle();
    expect(supplement.sender!.sendPhoto).not.toHaveBeenCalled();
    expect(supplement.sender!.sendMessage).not.toHaveBeenCalled();

    // The same picture asked for by a real turn of the same chat is not seen as a duplicate of a hidden one.
    const real = makeCtx(undefined, { imageDelivery: supplement.imageDelivery });
    expect(await run(real)).toMatchObject({ success: true });
    await real.imageDelivery!.whenIdle();
    expect(real.sender!.sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('unexpected render failures send one localized note without the internal error text', async () => {
    const ctx = makeCtx(() => Promise.reject(new Error('playwright down')));
    const result = await run(ctx);
    expect(result.success).toBe(true);
    await ctx.imageDelivery!.whenIdle();
    expect(ctx.sender!.sendMessage).toHaveBeenCalledTimes(1);
    const note = (ctx.sender!.sendMessage as ReturnType<typeof mock>).mock.calls[0]![1] as string;
    expect(note).toContain('could not prepare the picture');
    expect(note).not.toContain('playwright down');
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

  test('two members of one group asking for the same group day are two pictures, not a duplicate or a replacement', async () => {
    const first = makeCtx(undefined, { groupChatId: -100 });
    const second = makeCtx(undefined, {
      groupChatId: -100,
      user: { telegram_id: 2, language: 'en', timezone: 'UTC' },
      imageDelivery: first.imageDelivery,
    });
    expect(await handleRenderDayImage(first, { date: '2026-04-07', scope: 'group' })).toMatchObject({ success: true });
    expect(await handleRenderDayImage(second, { date: '2026-04-07', scope: 'group' })).toMatchObject({ success: true });
    await first.imageDelivery!.whenIdle();
    expect(first.sender!.sendPhoto).toHaveBeenCalledTimes(1);
    expect(second.sender!.sendPhoto).toHaveBeenCalledTimes(1);
  });

  test('the result says queued, not sent, and tells the model not to re-render', async () => {
    const result = await handleRenderDayImage(makeCtx(), { date: '2026-04-07' });
    expect(result.output).toBe(meta.dayImageQueued('2026-04-07'));
    // The output is what a workflow reply shows the user: it says "being prepared", never "sent".
    expect(result.output).not.toMatch(/\bsent\b/);
    expect(result.agentHint).toBe(
      'The picture is only QUEUED, NOT sent yet: it arrives later as a separate message (or the user gets a short note if it fails). Do NOT call render_day_image again for this date in this turn, and do NOT say the picture was sent or attached, write your text answer now.',
    );
  });

  test('a day that cannot be mapped into a render job fails the tool call with the localized text', async () => {
    const ctx = makeCtx(undefined, {
      eventService: {
        getEventsForDay: () => {
          throw new Error('boom');
        },
      },
    });
    const result = await handleRenderDayImage(ctx, { date: '2026-04-07' });
    expect(result).toEqual({ success: false, error: meta.dayImageFailed('2026-04-07') });
  });
});

describe('handleRenderWeekImage specifics', () => {
  test('a week that cannot be read fails the tool call with the localized text', async () => {
    const ctx = makeCtx(undefined, {
      eventService: {
        getEventsInRange: () => {
          throw new Error('boom');
        },
      },
    });
    const result = await handleRenderWeekImage(ctx, { week_start: '2026-04-08' });
    expect(result).toEqual({ success: false, error: meta.weekImageFailed('2026-04-08') });
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
  test('a month that cannot be read fails the tool call with the localized text', async () => {
    const ctx = makeCtx(undefined, {
      eventService: {
        getEventsInRange: () => {
          throw new Error('boom');
        },
      },
    });
    const result = await handleRenderMonthImage(ctx, { month: '2026-04' });
    expect(result).toEqual({ success: false, error: meta.monthImageFailed('2026-04') });
  });
});
