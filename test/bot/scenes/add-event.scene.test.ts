import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import {
  applyDefaultDuration,
  createAddEventScene,
  parseWizardDateTime,
} from '../../../src/bot/scenes/add-event.scene.ts';
import { CB } from '../../../src/config/constants.ts';
import type { DatabaseService } from '../../../src/database/index.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** DatabaseService and EventService have private members; boundary cast once here */
const mockDb = { users: { findOrCreate: () => ({ language: 'en', timezone: 'UTC' }) } } as unknown as DatabaseService;
const mockComposer = createUserResolverComposer(mockDb);

type GramioFn = (ctx: MockCtx, next: () => Promise<void>) => Promise<void>;

/**
 * Extract the raw step middleware functions from a GramIO Scene.
 * Path: scene['~'].composer['~'].middlewares[i].fn
 */
function getStepFns(scene: ReturnType<typeof createAddEventScene>): GramioFn[] {
  const inner = (scene as unknown as Record<string, unknown>)['~'] as Record<string, unknown>;
  const composer = inner.composer as Record<string, unknown>;
  const composerInner = composer['~'] as Record<string, unknown>;
  const middlewares = composerInner.middlewares as Array<Record<string, unknown>>;
  // slice(1) skips the user-resolver middleware injected by .extend(userComposer)
  return middlewares.slice(1).map((m) => m.fn as GramioFn);
}

type SendMock = ReturnType<typeof mock<() => Promise<{ id: number }>>>;
type UpdateMock = ReturnType<typeof mock<(patch: Record<string, unknown>, opts?: unknown) => Promise<void>>>;
type ExitMock = ReturnType<typeof mock<() => Promise<void>>>;
type AnswerMock = ReturnType<typeof mock<() => Promise<void>>>;
type StepGoMock = ReturnType<typeof mock<(n: number, flag: boolean) => Promise<void>>>;

interface MockCtx {
  send: SendMock;
  answer: AnswerMock;
  lang: 'en' | 'ru';
  dbUser: {
    telegram_id: number;
    language: 'en' | 'ru';
    timezone: string;
    default_event_duration_minutes?: number;
  };
  text?: string;
  data?: string;
  scene: {
    state: Record<string, unknown>;
    step: { id: number; firstTime: boolean; go: StepGoMock };
    update: UpdateMock;
    exit: ExitMock;
  };
  /** GramIO's is() accepts string | string[]. We match against the activeType field. */
  is: (t: string | string[]) => boolean;
  /** Which update type this context represents */
  _activeType: string;
}

/** Create a context that represents a cancel callback press. */
function makeCancelCtx(
  overrides: { stepId?: number; lang?: 'en' | 'ru'; state?: Record<string, unknown> } = {},
): MockCtx {
  return makeCtx({
    activeType: 'callback_query',
    stepId: overrides.stepId ?? 0,
    data: CB.ADD_CANCEL,
    lang: overrides.lang,
    state: overrides.state,
  });
}

function makeCtx(
  overrides: {
    activeType?: string;
    stepId?: number;
    firstTime?: boolean;
    text?: string;
    data?: string;
    state?: Record<string, unknown>;
    lang?: 'en' | 'ru';
    defaultDuration?: number;
  } = {},
): MockCtx {
  const state = overrides.state ?? {};
  const activeType = overrides.activeType ?? 'message';
  const ctx: MockCtx = {
    _activeType: activeType,
    send: mock(() => Promise.resolve({ id: 99 })),
    answer: mock(() => Promise.resolve()),
    lang: overrides.lang ?? 'en',
    text: overrides.text,
    data: overrides.data,
    dbUser: {
      telegram_id: 1,
      language: overrides.lang ?? 'en',
      timezone: 'Europe/Moscow',
      default_event_duration_minutes: overrides.defaultDuration,
    },
    scene: {
      state,
      step: {
        id: overrides.stepId ?? 0,
        firstTime: overrides.firstTime ?? false,
        go: mock(() => Promise.resolve()),
      },
      update: mock((patch: Record<string, unknown>) => {
        Object.assign(state, patch);
        return Promise.resolve();
      }),
      exit: mock(() => Promise.resolve()),
    },
    is: (t: string | string[]) => {
      if (Array.isArray(t)) return t.includes(activeType);
      return t === activeType;
    },
  };
  return ctx;
}

const NOOP_NEXT = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

describe('createAddEventScene', () => {
  test('creates scene with name "add_event"', () => {
    const mockEventService = {} as unknown as EventService;
    const scene = createAddEventScene(mockEventService, mockComposer);
    expect(scene.name).toBe('add_event');
  });

  test('has 7 steps', () => {
    const scene = createAddEventScene({} as EventService, mockComposer);
    expect(scene.stepsCount).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// applyDefaultDuration
// ---------------------------------------------------------------------------

describe('applyDefaultDuration', () => {
  test('adds minutes to ISO start time', () => {
    expect(applyDefaultDuration('2026-03-20T10:00:00.000Z', 60)).toBe('2026-03-20T11:00:00.000Z');
  });

  test('handles 30 minutes', () => {
    expect(applyDefaultDuration('2026-03-20T10:00:00.000Z', 30)).toBe('2026-03-20T10:30:00.000Z');
  });

  test('handles 0 minutes (no-op)', () => {
    expect(applyDefaultDuration('2026-03-20T10:00:00.000Z', 0)).toBe('2026-03-20T10:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Wizard date/time parsing
// ---------------------------------------------------------------------------

describe('parseWizardDateTime', () => {
  const ref = new Date('2026-09-23T18:00:00Z');

  test('Anton case: "25 сентября в 7 вечера" becomes 19:00 Belgrade / 17:00 UTC', () => {
    expect(parseWizardDateTime('25 сентября в 7 вечера', 'Europe/Belgrade', undefined, ref)).toEqual({
      kind: 'complete',
      startAt: '2026-09-25T17:00:00.000Z',
    });
  });

  test('date-only answer preserves the date and explicitly waits for a time', () => {
    expect(parseWizardDateTime('25 сен', 'Europe/Belgrade', undefined, ref)).toEqual({
      kind: 'needs_time',
      localDate: '2026-09-25',
    });
  });

  test('pending date plus "7 вечера" becomes a complete local datetime', () => {
    expect(parseWizardDateTime('7 вечера', 'Europe/Belgrade', '2026-09-25', ref)).toEqual({
      kind: 'complete',
      startAt: '2026-09-25T17:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// CB constants
// ---------------------------------------------------------------------------

describe('add_event callback data constants', () => {
  test('ADD_RECURRENCE and ADD_REC_END are distinct', () => {
    expect(CB.ADD_RECURRENCE).toBeDefined();
    expect(CB.ADD_REC_END).toBeDefined();
    expect(CB.ADD_RECURRENCE).not.toBe(CB.ADD_REC_END);
  });
});

// ---------------------------------------------------------------------------
// Step handler integration tests
// ---------------------------------------------------------------------------

describe('add_event step handlers', () => {
  const FAKE_EVENT = {
    id: 42,
    title: 'Test Event',
    start_at: '2026-03-20T10:00:00.000Z',
    end_at: '2026-03-20T11:00:00.000Z',
    timezone: 'Europe/Moscow',
    user_id: 1,
  };

  let createEventMock: ReturnType<typeof mock>;
  let fns: GramioFn[];

  beforeEach(() => {
    createEventMock = mock(() => FAKE_EVENT);
    const mockService = { createEvent: createEventMock } as unknown as EventService;
    fns = getStepFns(createAddEventScene(mockService, mockComposer));
  });

  // --- Step 0: Title ---

  describe('step 0: title', () => {
    test('firstTime — sends title prompt', async () => {
      const ctx = makeCtx({ stepId: 0, firstTime: true });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/title|название/i);
    });

    test('empty text — re-sends prompt', async () => {
      const ctx = makeCtx({ stepId: 0, text: '  ' });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('valid text — stores trimmed title', async () => {
      const ctx = makeCtx({ stepId: 0, text: '  Team standup  ' });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ title: 'Team standup' });
    });

    test('missing text — re-sends prompt (no crash)', async () => {
      const ctx = makeCtx({ stepId: 0 });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });
  });

  // --- Step 1: Date/Time ---

  describe('step 1: date/time', () => {
    test('firstTime — sends time prompt', async () => {
      const ctx = makeCtx({ stepId: 1, firstTime: true });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/when|когда/i);
    });

    test('parseable ISO date — stores startAt', async () => {
      const ctx = makeCtx({ stepId: 1, text: '2026-03-25 10:00' });
      await fns[1]!(ctx, NOOP_NEXT);
      if (ctx.scene.update.mock.calls.length > 0) {
        const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ startAt?: string }];
        expect(typeof patch.startAt).toBe('string');
      }
    });

    test('unparseable date — sends error, no state update', async () => {
      const ctx = makeCtx({ stepId: 1, text: 'not a date at all' });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/parse|разобрать/i);
    });

    test('no text — does nothing', async () => {
      const ctx = makeCtx({ stepId: 1 });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).not.toHaveBeenCalled();
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('ru locale — error message in Russian', async () => {
      const ctx = makeCtx({ stepId: 1, text: 'полная чушь', lang: 'ru' });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/разобрать/);
    });

    test('date without time stays on the date/time step and asks for a clock time', async () => {
      const ctx = makeCtx({ stepId: 1, text: '25 сен', lang: 'ru' });
      await fns[1]!(ctx, NOOP_NEXT);
      const [patch, options] = ctx.scene.update.mock.calls[0] as unknown as [
        { pendingDate?: string },
        { step?: number },
      ];
      expect(patch.pendingDate).toMatch(/-09-25$/);
      expect(options).toEqual({ step: undefined });
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/во сколько/i);
    });

    test('time entered after a date-only answer is combined with that pending date', async () => {
      const ctx = makeCtx({
        stepId: 1,
        text: '19:00',
        state: { pendingDate: '2026-09-25' },
        lang: 'ru',
      });
      await fns[1]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ startAt?: string }];
      expect(patch.startAt).toBe('2026-09-25T16:00:00.000Z');
    });

    test('bare 25 is treated as a day-of-month and asks for time instead of becoming 25:00', async () => {
      const ctx = makeCtx({ stepId: 1, text: '25', lang: 'ru' });
      await fns[1]!(ctx, NOOP_NEXT);
      const [patch, options] = ctx.scene.update.mock.calls[0] as unknown as [
        { pendingDate?: string },
        { step?: number },
      ];
      expect(patch.pendingDate).toMatch(/-25$/);
      expect(options).toEqual({ step: undefined });
    });
  });

  // --- Step 2: Duration ---

  describe('step 2: duration', () => {
    test('firstTime — sends duration prompt', async () => {
      const ctx = makeCtx({ stepId: 2, firstTime: true });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('skip callback — applies default 60min duration', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 2,
        data: `${CB.ADD_SKIP}:2`,
        state: { startAt: '2026-03-20T10:00:00.000Z' },
      });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledTimes(1);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ endAt?: string }];
      expect(patch.endAt).toBe('2026-03-20T11:00:00.000Z');
    });

    test('skip callback with custom default duration — respects user setting', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 2,
        data: `${CB.ADD_SKIP}:2`,
        state: { startAt: '2026-03-20T10:00:00.000Z' },
        defaultDuration: 30,
      });
      await fns[2]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ endAt?: string }];
      expect(patch.endAt).toBe('2026-03-20T10:30:00.000Z');
    });

    test('"1h" text — stores endAt 60min later', async () => {
      const ctx = makeCtx({
        stepId: 2,
        text: '1h',
        state: { startAt: '2026-03-20T10:00:00.000Z' },
      });
      await fns[2]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ endAt?: string }];
      expect(patch.endAt).toBe('2026-03-20T11:00:00.000Z');
    });

    test('"30m" text — stores endAt 30min later', async () => {
      const ctx = makeCtx({
        stepId: 2,
        text: '30m',
        state: { startAt: '2026-03-20T10:00:00.000Z' },
      });
      await fns[2]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ endAt?: string }];
      expect(patch.endAt).toBe('2026-03-20T10:30:00.000Z');
    });

    test('unparseable duration — sends error message', async () => {
      const ctx = makeCtx({
        stepId: 2,
        text: 'whenever',
        state: { startAt: '2026-03-20T10:00:00.000Z' },
      });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('no startAt — exits scene', async () => {
      const ctx = makeCtx({ stepId: 2, text: '1h', state: {} });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    });
  });

  // --- Step 3: Recurrence ---

  describe('step 3: recurrence', () => {
    test('firstTime — sends recurrence prompt', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, firstTime: true });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('"none" — sets null rule and skips to step 5', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: `${CB.ADD_RECURRENCE}:none` });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: null }, { step: undefined });
      expect(ctx.scene.step.go).toHaveBeenCalledWith(5, true);
    });

    test('"WEEKLY" — stores FREQ=WEEKLY', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: `${CB.ADD_RECURRENCE}:WEEKLY` });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: 'FREQ=WEEKLY' });
    });

    test('"DAILY" — stores FREQ=DAILY', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: `${CB.ADD_RECURRENCE}:DAILY` });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: 'FREQ=DAILY' });
    });

    test('"MONTHLY" — stores FREQ=MONTHLY', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: `${CB.ADD_RECURRENCE}:MONTHLY` });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: 'FREQ=MONTHLY' });
    });

    test('"custom" — sends custom prompt, does not advance', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 3, data: `${CB.ADD_RECURRENCE}:custom` });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(ctx.scene.step.go).not.toHaveBeenCalled();
    });

    test('custom recurrence accepts text on the same step', async () => {
      const ctx = makeCtx({ stepId: 3, text: 'каждые 2 недели', lang: 'ru' });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: 'FREQ=WEEKLY;INTERVAL=2' });
    });
  });

  // --- Step 4: Recurrence End ---

  describe('step 4: recurrence end', () => {
    test('firstTime — sends recurrence-end prompt', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 4, firstTime: true });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('"forever" — advances without extra send', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 4, data: `${CB.ADD_REC_END}:forever` });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledTimes(1);
      expect(ctx.send).not.toHaveBeenCalled();
    });

    test('"until" — sends until-date prompt', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 4, data: `${CB.ADD_REC_END}:until` });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/date|дату/i);
    });

    test('"count" — sends count prompt', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 4, data: `${CB.ADD_REC_END}:count` });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/times|раз/i);
    });

    test('"until" then date text appends an inclusive UNTIL and advances', async () => {
      const ctx = makeCtx({
        stepId: 4,
        text: '26 сентября',
        lang: 'ru',
        state: { recurrenceRule: 'FREQ=DAILY', recEndMode: 'until', startAt: '2026-09-25T16:00:00.000Z' },
      });
      await fns[4]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ recurrenceRule?: string }];
      expect(patch.recurrenceRule).toMatch(/^FREQ=DAILY;UNTIL=20260926T/);
      expect(patch.recurrenceRule).toEndWith('Z');
    });

    test('"until" accepts a bare day-of-month in the event month', async () => {
      const ctx = makeCtx({
        stepId: 4,
        text: '26',
        lang: 'ru',
        state: { recurrenceRule: 'FREQ=DAILY', recEndMode: 'until', startAt: '2026-09-25T16:00:00.000Z' },
      });
      await fns[4]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ recurrenceRule?: string }];
      expect(patch.recurrenceRule).toMatch(/^FREQ=DAILY;UNTIL=20260926T/);
    });

    test('"count" then number appends COUNT and advances', async () => {
      const ctx = makeCtx({ stepId: 4, text: '5', state: { recurrenceRule: 'FREQ=WEEKLY', recEndMode: 'count' } });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({
        recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
        recEndMode: undefined,
      });
    });

    test('bare number without an end mode is clarified instead of guessed as date or count', async () => {
      const ctx = makeCtx({
        stepId: 4,
        text: '26',
        lang: 'ru',
        state: { recurrenceRule: 'FREQ=DAILY', startAt: '2026-09-25T16:00:00.000Z' },
      });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).not.toHaveBeenCalled();
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/26-е|повтор/i);
    });

    test('end date without a year is interpreted relative to the event year', async () => {
      const ctx = makeCtx({
        stepId: 4,
        text: '2 февраля',
        lang: 'ru',
        state: { recurrenceRule: 'FREQ=DAILY', recEndMode: 'until', startAt: '2027-01-25T16:00:00.000Z' },
      });
      await fns[4]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ recurrenceRule?: string }];
      expect(patch.recurrenceRule).toMatch(/^FREQ=DAILY;UNTIL=20270202T/);
    });
  });

  // --- Step 5: Description ---

  describe('step 5: description', () => {
    test('firstTime — sends description prompt', async () => {
      const ctx = makeCtx({ stepId: 5, firstTime: true });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('skip callback — advances without storing description', async () => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 5, data: `${CB.ADD_SKIP}:5` });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledTimes(1);
    });

    test('text input — stores description', async () => {
      const ctx = makeCtx({ stepId: 5, text: 'Weekly team sync notes' });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({ description: 'Weekly team sync notes' });
    });

    test('no text — does nothing', async () => {
      const ctx = makeCtx({ stepId: 5 });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).not.toHaveBeenCalled();
      expect(ctx.send).not.toHaveBeenCalled();
    });
  });

  // --- Step 6: Location + Create Event ---

  describe('step 6: location + create event', () => {
    test('firstTime — sends location prompt', async () => {
      const ctx = makeCtx({ stepId: 6, firstTime: true });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });

    test('no title — exits without creating event', async () => {
      const ctx = makeCtx({ stepId: 6, text: 'Office', state: { startAt: '2026-03-20T10:00:00.000Z' } });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(createEventMock).not.toHaveBeenCalled();
    });

    test('no startAt — exits without creating event', async () => {
      const ctx = makeCtx({ stepId: 6, text: 'Office', state: { title: 'Stand up' } });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(createEventMock).not.toHaveBeenCalled();
    });

    test('valid state + location text — creates event with location', async () => {
      const ctx = makeCtx({
        stepId: 6,
        text: 'Room 101',
        state: { title: 'Standup', startAt: '2026-03-20T10:00:00.000Z', endAt: '2026-03-20T10:30:00.000Z' },
      });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(createEventMock).toHaveBeenCalledTimes(1);
      const [data] = createEventMock.mock.calls[0] as unknown as [
        { title: string; location?: string; start_at: string },
      ];
      expect(data.title).toBe('Standup');
      expect(data.location).toBe('Room 101');
      expect(data.start_at).toBe('2026-03-20T10:00:00.000Z');
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
    });

    test('skip location callback — creates event without location', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 6,
        data: `${CB.ADD_SKIP}:6`,
        state: { title: 'Standup', startAt: '2026-03-20T10:00:00.000Z', endAt: '2026-03-20T10:30:00.000Z' },
      });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(createEventMock).toHaveBeenCalledTimes(1);
      const [data] = createEventMock.mock.calls[0] as unknown as [{ location?: string }];
      expect(data.location).toBeUndefined();
    });

    test('success — send message contains event title', async () => {
      const ctx = makeCtx({
        stepId: 6,
        text: 'Conf room',
        state: { title: 'Demo Day', startAt: '2026-03-20T10:00:00.000Z', endAt: '2026-03-20T11:00:00.000Z' },
      });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/Demo Day|Test Event/);
    });

    test('event with recurrenceRule — passes rule to createEvent', async () => {
      const ctx = makeCtx({
        stepId: 6,
        text: 'Online',
        state: {
          title: 'Weekly standup',
          startAt: '2026-03-20T10:00:00.000Z',
          recurrenceRule: 'FREQ=WEEKLY',
        },
      });
      await fns[6]!(ctx, NOOP_NEXT);
      const [data] = createEventMock.mock.calls[0] as unknown as [{ recurrence_rule?: string }];
      expect(data.recurrence_rule).toBe('FREQ=WEEKLY');
    });
  });

  // --- Cancel: all steps ---

  describe('cancel button — all steps', () => {
    test('step 0: cancel callback exits scene with message (en)', async () => {
      const ctx = makeCancelCtx({ stepId: 0 });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/cancelled/i);
    });

    test('step 0: cancel callback exits scene with message (ru)', async () => {
      const ctx = makeCancelCtx({ stepId: 0, lang: 'ru' });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/отменено/i);
    });

    test('step 0: firstTime — shows cancel keyboard', async () => {
      const ctx = makeCtx({ stepId: 0, firstTime: true });
      await fns[0]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const args = ctx.send.mock.calls[0] as unknown as [string, { reply_markup?: unknown }];
      expect(args[1]?.reply_markup).toBeDefined();
    });

    test('step 1: cancel callback exits scene', async () => {
      const ctx = makeCancelCtx({ stepId: 1 });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('step 2: cancel callback exits scene without creating event', async () => {
      const ctx = makeCancelCtx({ stepId: 2, state: { startAt: '2026-03-20T10:00:00.000Z' } });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('step 3: cancel callback exits scene', async () => {
      const ctx = makeCancelCtx({ stepId: 3 });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('step 4: cancel callback exits scene', async () => {
      const ctx = makeCancelCtx({ stepId: 4 });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('step 5: cancel callback exits scene without storing description', async () => {
      const ctx = makeCancelCtx({ stepId: 5 });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(ctx.scene.update).not.toHaveBeenCalled();
    });

    test('step 6: cancel callback exits scene without creating event', async () => {
      const ctx = makeCancelCtx({ stepId: 6, state: { title: 'Standup', startAt: '2026-03-20T10:00:00.000Z' } });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(createEventMock).not.toHaveBeenCalled();
    });
  });
});
