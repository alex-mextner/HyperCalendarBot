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
  const state = overrides.state ?? (overrides.stepId === 4 ? { recurrenceRule: 'FREQ=DAILY' } : {});
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

  test('has 8 steps including final confirmation', () => {
    const scene = createAddEventScene({} as EventService, mockComposer);
    expect(scene.stepsCount).toBe(8);
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

describe('wizard date/time corrections and boundaries (GH-359)', () => {
  const ref = new Date('2026-09-23T18:00:00Z');
  test.each([
    ['в 19', '2026-09-23T17:00:00.000Z'],
    ['сегодня 19', '2026-09-23T17:00:00.000Z'],
    ['пн 10', '2026-09-28T08:00:00.000Z'],
    ['25.09.2026 19:00', '2026-09-25T17:00:00.000Z'],
    ['2026-09-25 19:00', '2026-09-25T17:00:00.000Z'],
  ])('explicit local time %s does not ask for it a second time', (input, startAt) => {
    expect(parseWizardDateTime(input, 'Europe/Belgrade', undefined, ref)).toEqual({ kind: 'complete', startAt });
  });
  test.each(['сегодня', '25.09', '2026-09-25', 'пятница'])('date-only %s asks for time', (input) => {
    expect(parseWizardDateTime(input, 'Europe/Belgrade', undefined, ref).kind).toBe('needs_time');
  });
  test('a full correction replaces a pending date', () => {
    expect(parseWizardDateTime('26 сен 20:00', 'Europe/Belgrade', '2026-09-25', ref)).toEqual({
      kind: 'complete',
      startAt: '2026-09-26T18:00:00.000Z',
    });
  });
  test.each(['2026-03-29', '2026-10-25'])('clock change on %s requires clarification', (date) => {
    expect(parseWizardDateTime('02:30', 'Europe/Belgrade', date, ref).kind).toBe('invalid');
  });
  test('a corrupt pending date cannot roll into a different month', () => {
    expect(parseWizardDateTime('19:00', 'Europe/Belgrade', '2026-02-31', ref).kind).toBe('invalid');
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
    const mockService = { createEvent: createEventMock, getEvent: () => FAKE_EVENT } as unknown as EventService;
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
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
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
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/parse|разобрать/i);
    });

    test('no text — explains supported input without changing event data', async () => {
      const ctx = makeCtx({ stepId: 1 });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
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

    test('pendingDate set — a bare ambiguous hour offers candidates and writes nothing', async () => {
      const ctx = makeCtx({ stepId: 1, text: '2', lang: 'ru', state: { pendingDate: '2026-06-15' } });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/время/i);
    });

    test('pendingDate set — picking the "add:time:HH:MM" candidate resolves that exact instant', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: `${CB.ADD_TIME_CHOICE}:14:00`,
        state: { pendingDate: '2026-06-15' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({
        startAt: '2026-06-15T11:00:00.000Z',
        endAt: undefined,
        pendingDate: undefined,
        allDay: false,
      });
    });

    test('pendingDate set — a candidate re-resolved into a DST gap is rejected, not silently accepted', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: `${CB.ADD_TIME_CHOICE}:02:00`,
        state: { pendingDate: '2026-03-29' },
        lang: 'ru',
        text: undefined,
      });
      ctx.dbUser.timezone = 'Europe/Belgrade';
      await fns[1]!(ctx, NOOP_NEXT);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/разобрать/);
    });

    test('pendingDate set — a forged fold-candidate callback for an arbitrary date is rejected', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: `${CB.ADD_TIME_CHOICE}:2099-01-01T00:00:00+00:00`,
        state: { pendingDate: '2026-06-15' },
        lang: 'ru',
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/разобрать/);
    });

    test('pendingDate set — a real fold candidate for this exact pendingDate is accepted', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: `${CB.ADD_TIME_CHOICE}:2026-10-25T02:00:00+02:00`,
        state: { pendingDate: '2026-10-25' },
      });
      ctx.dbUser.timezone = 'Europe/Belgrade';
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith({
        startAt: '2026-10-25T00:00:00.000Z',
        endAt: undefined,
        pendingDate: undefined,
        allDay: false,
      });
    });

    test('pendingDate set — the All day callback marks all_day and stores an exclusive next-day end', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: CB.ADD_ALL_DAY,
        state: { pendingDate: '2026-06-15' },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith(
        {
          // The default mock user's timezone is Europe/Moscow (+03:00, no DST), so local
          // midnight renders "+03:00", not "Z" — @date-fns/tz's TZDate#toISOString always
          // spells out an explicit offset.
          startAt: '2026-06-15T00:00:00.000+03:00',
          endAt: '2026-06-16T00:00:00.000+03:00',
          pendingDate: undefined,
          allDay: true,
        },
        { step: 3 },
      );
    });

    test('pendingDate set — the All day callback in a negative-offset zone keeps the chosen calendar date', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: CB.ADD_ALL_DAY,
        state: { pendingDate: '2027-03-10' },
      });
      ctx.dbUser.timezone = 'America/New_York';
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith(
        {
          // Naive "...T00:00:00.000Z" storage would read back as March 9 anywhere west of UTC;
          // the actual local-midnight instant (-05:00 in March, before New York's DST start)
          // keeps both the start and the exclusive end on their real calendar day.
          startAt: '2027-03-10T00:00:00.000-05:00',
          endAt: '2027-03-11T00:00:00.000-05:00',
          pendingDate: undefined,
          allDay: true,
        },
        { step: 3 },
      );
    });

    test('pendingDate set — Change date clears the pending time state and re-asks the date question', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 1,
        data: CB.ADD_CHANGE_DATE,
        lang: 'ru',
        state: { pendingDate: '2026-06-15', startAt: '2026-06-15T00:00:00.000Z', allDay: true },
      });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(ctx.scene.update).toHaveBeenCalledWith(
        { pendingDate: undefined, startAt: undefined, endAt: undefined, allDay: false },
        { step: undefined },
      );
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/когда/i);
    });

    test('pendingDate set — an unknown-time phrase asks for a time or All day, without writing', async () => {
      const ctx = makeCtx({ stepId: 1, text: 'время пока не знаю', lang: 'ru', state: { pendingDate: '2026-06-15' } });
      await fns[1]!(ctx, NOOP_NEXT);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      const [msg] = ctx.send.mock.calls[0] as unknown as [string];
      expect(msg).toMatch(/весь день/i);
    });

    test('pendingDate set — a full date correction replaces the stale pending date instead of failing as a time', async () => {
      const ctx = makeCtx({ stepId: 1, text: '26 сен 20:00', lang: 'ru', state: { pendingDate: '2026-01-01' } });
      await fns[1]!(ctx, NOOP_NEXT);
      const [patch] = ctx.scene.update.mock.calls[0] as unknown as [{ startAt?: string; pendingDate?: string }];
      expect(patch.pendingDate).toBeUndefined();
      expect(typeof patch.startAt).toBe('string');
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
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('no startAt — returns to the date step preserving draft', async () => {
      const ctx = makeCtx({ stepId: 2, text: '1h', state: {} });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.scene.step.go).toHaveBeenCalledWith(1, true);
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
      expect(ctx.scene.update).toHaveBeenCalledWith({ recurrenceRule: null, recEndMode: undefined }, { step: 5 });
      expect(ctx.scene.step.go).not.toHaveBeenCalled();
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
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
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

    test('no text — explains supported input without changing event data', async () => {
      const ctx = makeCtx({ stepId: 5 });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });
  });

  // --- Step 6: Location + Create Event ---

  describe('location, preview and confirmation', () => {
    test('location entry shows its prompt', async () => {
      const ctx = makeCtx({ stepId: 6, firstTime: true });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.send).toHaveBeenCalledTimes(1);
    });
    test.each([
      { startAt: '2026-03-20T10:00:00Z' },
      { title: 'Standup' },
    ])('missing required data blocks confirmation', async (state) => {
      const ctx = makeCtx({ activeType: 'callback_query', stepId: 7, data: 'add:confirm', state });
      await fns[7]!(ctx, NOOP_NEXT);
      expect(createEventMock).not.toHaveBeenCalled();
      expect(ctx.scene.exit).not.toHaveBeenCalled();
      const [text] = ctx.send.mock.calls[0] as unknown as [string];
      expect(text).toContain('missing');
    });
    test.each(['Room 101', 'Office'])('location %s is only a draft until confirmation', async (location) => {
      const state = { title: 'Standup', startAt: '2026-03-20T10:00:00Z' };
      const ctx = makeCtx({ stepId: 6, text: location, state });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(createEventMock).not.toHaveBeenCalled();
      expect(ctx.scene.state.location).toBe(location);
      const confirm = makeCtx({ activeType: 'callback_query', stepId: 7, data: 'add:confirm', state: ctx.scene.state });
      await fns[7]!(confirm, NOOP_NEXT);
      expect(createEventMock).toHaveBeenCalledTimes(1);
      const [data] = createEventMock.mock.calls[0] as unknown as [{ location: string }];
      expect(data.location).toBe(location);
    });
    test('skip location clears an earlier location instead of retaining it', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 6,
        data: `${CB.ADD_SKIP}:6`,
        state: { location: 'Old place' },
      });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.scene.state.location).toBeUndefined();
      expect(createEventMock).not.toHaveBeenCalled();
    });
    test('preview shows the exact title safely and writes nothing', async () => {
      const ctx = makeCtx({
        stepId: 7,
        firstTime: true,
        state: { title: 'Demo <Day>', startAt: '2026-03-20T10:00:00Z' },
      });
      await fns[7]!(ctx, NOOP_NEXT);
      const [text] = ctx.send.mock.calls[0] as unknown as [string];
      expect(text).toContain('Demo &lt;Day&gt;');
      expect(createEventMock).not.toHaveBeenCalled();
    });
    test('confirmation passes the recurrence unchanged to storage', async () => {
      const ctx = makeCtx({
        activeType: 'callback_query',
        stepId: 7,
        data: 'add:confirm',
        state: {
          title: 'Weekly standup',
          startAt: '2026-03-20T10:00:00Z',
          recurrenceRule: 'FREQ=WEEKLY;COUNT=5',
        },
      });
      await fns[7]!(ctx, NOOP_NEXT);
      const [data] = createEventMock.mock.calls[0] as unknown as [{ recurrence_rule: string }];
      expect(data.recurrence_rule).toBe('FREQ=WEEKLY;COUNT=5');
    });
    test('typing on the preview cannot accidentally confirm', async () => {
      const ctx = makeCtx({ stepId: 7, text: 'Wait', state: { title: 'Test', startAt: '2026-03-20T10:00:00Z' } });
      await fns[7]!(ctx, NOOP_NEXT);
      expect(createEventMock).not.toHaveBeenCalled();
      expect(ctx.send).toHaveBeenCalledTimes(1);
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
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('step 2: cancel callback exits scene without creating event', async () => {
      const ctx = makeCancelCtx({ stepId: 2, state: { startAt: '2026-03-20T10:00:00.000Z' } });
      await fns[2]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('step 3: cancel callback exits scene', async () => {
      const ctx = makeCancelCtx({ stepId: 3 });
      await fns[3]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('step 4: cancel callback exits scene', async () => {
      const ctx = makeCancelCtx({ stepId: 4 });
      await fns[4]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('step 5: cancel callback exits scene without storing description', async () => {
      const ctx = makeCancelCtx({ stepId: 5 });
      await fns[5]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(
        ctx.scene.update.mock.calls.filter(([patch]) => Object.keys(patch).some((key) => key !== 'promptMessageId')),
      ).toHaveLength(0);
    });

    test('step 6: cancel callback exits scene without creating event', async () => {
      const ctx = makeCancelCtx({ stepId: 6, state: { title: 'Standup', startAt: '2026-03-20T10:00:00.000Z' } });
      await fns[6]!(ctx, NOOP_NEXT);
      expect(ctx.scene.exit).toHaveBeenCalledTimes(1);
      expect(createEventMock).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Location verification (#395): a location typed in /add goes through the same
// verification and clarification flow as the AI create_event tool.
// ---------------------------------------------------------------------------

describe('add_event confirmation: location verification', () => {
  const STATE = { title: 'Dinner', startAt: '2026-10-05T17:00:00.000Z', endAt: '2026-10-05T18:00:00.000Z' };

  function setup() {
    const createEvent = mock((data: { location?: string }) => ({
      id: 77,
      title: STATE.title,
      start_at: STATE.startAt,
      end_at: STATE.endAt,
      timezone: 'Europe/Moscow',
      user_id: 1,
      location: data.location ?? null,
    }));
    const verifyEventLocation = mock(() =>
      Promise.resolve({ resolved: false, geocoded: null, cityExtracted: null, candidates: [] }),
    );
    const service = { createEvent, getEvent: () => createEvent.mock.results.at(-1)?.value } as unknown as EventService;
    const fns = getStepFns(createAddEventScene(service, mockComposer, undefined, undefined, { verifyEventLocation }));
    return { fns, verifyEventLocation };
  }

  test('typed location — verifies the created event for the user', async () => {
    const { fns, verifyEventLocation } = setup();
    const ctx = makeCtx({ stepId: 6, text: 'harbour cafe', state: { ...STATE } });
    await fns[6]!(ctx, NOOP_NEXT);
    expect(verifyEventLocation).not.toHaveBeenCalled();
    const confirmation = makeCtx({
      activeType: 'callback_query',
      stepId: 7,
      data: 'add:confirm',
      state: ctx.scene.state,
    });
    await fns[7]!(confirmation, NOOP_NEXT);

    expect(verifyEventLocation).toHaveBeenCalledTimes(1);
    const [event, user] = verifyEventLocation.mock.calls[0] as unknown as [
      { id: number; location: string },
      { telegram_id: number },
    ];
    expect(event.id).toBe(77);
    expect(event.location).toBe('harbour cafe');
    expect(user.telegram_id).toBe(1);
  });

  test('skipped location — nothing to verify', async () => {
    const { fns, verifyEventLocation } = setup();
    const ctx = makeCtx({ activeType: 'callback_query', stepId: 6, data: `${CB.ADD_SKIP}:6`, state: { ...STATE } });
    await fns[6]!(ctx, NOOP_NEXT);
    expect(verifyEventLocation).not.toHaveBeenCalled();
    const confirmation = makeCtx({
      activeType: 'callback_query',
      stepId: 7,
      data: 'add:confirm',
      state: ctx.scene.state,
    });
    await fns[7]!(confirmation, NOOP_NEXT);

    expect(verifyEventLocation).not.toHaveBeenCalled();
  });
});
