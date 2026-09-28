// test/bot/commands/event.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { handleEvent } from '../../../src/bot/commands/event.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

/** Centralized cast per CLAUDE.md's test-factory exception: only the fields handleEvent
 *  actually reads (dbUser, args, chat, send) are implemented, not the full BotCommandContext. */
function makeCtx(overrides: { [key: string]: unknown } = {}): BotCommandContext {
  return {
    dbUser: user,
    args: '',
    chat: undefined,
    send: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as BotCommandContext;
}

/** Same exception: only the EventService methods a given test exercises are implemented. */
function makeSvc(overrides: { [key: string]: unknown } = {}): EventService {
  return overrides as unknown as EventService;
}

function makeEvent(overrides: Partial<CalendarEvent> = {}) {
  return {
    id: 1,
    user_id: 100,
    title: 'Team Meeting',
    start_at: '2026-03-15T10:00:00Z',
    end_at: '2026-03-15T11:00:00Z',
    timezone: 'UTC',
    recurrence_rule: null,
    description: null,
    location: null,
    ...overrides,
  };
}

function makeOccurrence(event: ReturnType<typeof makeEvent>) {
  return { event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false };
}

describe('handleEvent', () => {
  describe('by numeric id', () => {
    test('sends the canonical card with a keyboard when found', async () => {
      const event = makeEvent({ id: 42, title: 'Retro' });
      const svc = makeSvc({ getEvent: mock(() => event) });
      const ctx = makeCtx({ args: '42' });
      await handleEvent(ctx, svc);
      expect(svc.getEvent).toHaveBeenCalledWith(42, 100);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toContain('Retro');
      const opts = args[1] as { parse_mode: string; reply_markup: unknown };
      expect(opts.parse_mode).toBe('HTML');
      expect(opts.reply_markup).toBeDefined();
    });

    test('reports a distinct not-found error, never an empty message', async () => {
      const svc = makeSvc({ getEvent: mock(() => null) });
      const ctx = makeCtx({ args: '999' });
      await handleEvent(ctx, svc);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect((args[0] as string).toLowerCase()).not.toContain('no events');
    });

    test('in a group resolves via getEventForGroup, not the personal getEvent', async () => {
      const event = makeEvent({ id: 7, title: 'Group sync' });
      const svc = makeSvc({ getEvent: mock(() => null), getEventForGroup: mock(() => event) });
      const ctx = makeCtx({ args: '7', chat: { type: 'supergroup', id: -500 } });
      await handleEvent(ctx, svc);
      expect(svc.getEventForGroup).toHaveBeenCalledWith(7, -500);
      expect(svc.getEvent).not.toHaveBeenCalled();
    });

    test('a long description is split into bounded chunks without losing the action keyboard', async () => {
      const event = makeEvent({ id: 42, title: 'Long event', description: 'x'.repeat(5000) });
      const svc = makeSvc({ getEvent: mock(() => event) });
      const ctx = makeCtx({ args: '42' });
      await handleEvent(ctx, svc);
      const calls = (ctx.send as ReturnType<typeof mock>).mock.calls as unknown[][];
      expect(calls.length).toBeGreaterThan(1);
      for (const call of calls) {
        const text = call[0] as string;
        expect(text.length).toBeLessThanOrEqual(4000);
      }
      const last = calls[calls.length - 1]!;
      const lastOpts = last[1] as { reply_markup: unknown };
      expect(lastOpts.reply_markup).toBeDefined();
      for (const call of calls.slice(0, -1)) {
        const opts = call[1] as { reply_markup?: unknown } | undefined;
        expect(opts?.reply_markup).toBeUndefined();
      }
    });
  });

  describe('by title query', () => {
    test('one match sends the canonical card', async () => {
      const svc = makeSvc({ searchEvents: mock(() => [makeEvent({ title: 'Retro' })]) });
      const ctx = makeCtx({ args: 'retro' });
      await handleEvent(ctx, svc);
      expect(svc.searchEvents).toHaveBeenCalledWith(100, 'retro');
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toContain('Retro');
      expect((args[1] as { reply_markup: unknown }).reply_markup).toBeDefined();
    });

    test('several matches send a picker, never the first guess', async () => {
      const svc = makeSvc({
        searchEvents: mock(() => [makeEvent({ id: 1, title: 'Standup' }), makeEvent({ id: 2, title: 'Retro' })]),
      });
      const ctx = makeCtx({ args: 'meeting' });
      await handleEvent(ctx, svc);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      const kbText = JSON.stringify((args[1] as { reply_markup: unknown }).reply_markup);
      expect(kbText).toContain('Standup');
      expect(kbText).toContain('Retro');
    });

    test('no matches sends a clear "nothing found" message', async () => {
      const svc = makeSvc({ searchEvents: mock(() => []) });
      const ctx = makeCtx({ args: 'nonexistent' });
      await handleEvent(ctx, svc);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toBe('No events found.');
    });

    test('russian language uses the russian "nothing found" text', async () => {
      const svc = makeSvc({ searchEvents: mock(() => []) });
      const ctx = makeCtx({ args: 'nope', dbUser: userRu });
      await handleEvent(ctx, svc);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toBe('Ничего не найдено.');
    });
  });

  describe("with no args — today's single event", () => {
    test('one event today sends the canonical card', async () => {
      const event = makeEvent({ title: "Today's meeting" });
      const svc = makeSvc({ getEventsInRange: mock(() => [makeOccurrence(event)]) });
      const ctx = makeCtx({ args: '' });
      await handleEvent(ctx, svc);
      expect(svc.getEventsInRange).toHaveBeenCalledTimes(1);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toContain("Today's meeting");
    });

    test('no events today sends the day-empty message, not a search-empty message', async () => {
      const svc = makeSvc({ getEventsInRange: mock(() => []) });
      const ctx = makeCtx({ args: '' });
      await handleEvent(ctx, svc);
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).not.toBe('No events found.');
    });

    test('in a group queries the group calendar for today', async () => {
      const event = makeEvent({ title: 'Group standup', owner_type: 'group', group_id: -500 });
      const svc = makeSvc({
        getEventsInRange: mock(() => []),
        getEventsInRangeForGroup: mock(() => [makeOccurrence(event)]),
      });
      const ctx = makeCtx({ args: '', chat: { type: 'supergroup', id: -500 } });
      await handleEvent(ctx, svc);
      expect(svc.getEventsInRangeForGroup).toHaveBeenCalledTimes(1);
      expect(svc.getEventsInRange).not.toHaveBeenCalled();
      const args = (ctx.send as ReturnType<typeof mock>).mock.calls[0] as unknown[];
      expect(args[0] as string).toContain('Group standup');
    });
  });
});
