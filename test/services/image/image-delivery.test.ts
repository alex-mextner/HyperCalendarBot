// ImageDelivery: the background delivery behind the AI picture tools. A scripted renderer stands in for
// the BullMQ worker and fake Telegram functions for the API; everything else is the production code.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { t } from '../../../src/config/constants.ts';
import {
  ImageDelivery,
  type ImageDeliveryRequest,
  MAX_PENDING_CONFLICT_PER_CHAT,
  MAX_PENDING_CONFLICT_TOTAL,
  MAX_PENDING_PER_CHAT,
  MAX_PENDING_TOTAL,
  type RenderFailureReport,
} from '../../../src/services/image/image-delivery.ts';
import { RenderAbortedError, type RenderOptions } from '../../../src/services/image/render-service.ts';
import {
  configureTimeoutReporter,
  TIMEOUT_ALERT_SOURCE,
  TimeoutReporter,
} from '../../../src/services/incident/timeout-reporter.ts';
import { AgendaImageError } from '../../../src/utils/agenda-image.ts';
import { imageLogger } from '../../../src/utils/logger.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { png } from '../../fixtures/png.ts';

const tr = t('en').aiTools.meta;

/** Lets every already-settled promise continuation run (a macrotask turn, no wall-clock wait). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Pending {
  job: ImageRenderJob;
  options: RenderOptions | undefined;
  resolve(buffer: Buffer): void;
  reject(err: unknown): void;
}

/**
 * A renderer whose every job stays pending until the test settles it (or its signal aborts). With
 * `ignoreAbort` it keeps running after the delivery stopped waiting, like a worker that already runs the
 * job: its late result is the thing the delivery must not send.
 */
function scriptedRenderer(ignoreAbort = false) {
  const jobs: Pending[] = [];
  return {
    jobs,
    renderDirect: mock((job: ImageRenderJob, options?: RenderOptions) => {
      const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
      if (!ignoreAbort)
        options?.signal?.addEventListener('abort', () => reject(new RenderAbortedError()), { once: true });
      jobs.push({ job, options, resolve, reject });
      return promise;
    }),
  };
}

function job(date: string, extra: string = ''): ImageRenderJob {
  return {
    type: 'daily-agenda',
    data: {
      date,
      dayOfWeek: 'Tue',
      dateFormatted: date,
      eventCount: 0,
      allDayEvents: [],
      timedEvents: [],
      theme: { name: 'synthetic' } as never,
      locale: 'en',
      holidayName: extra,
    },
    userId: 1,
  } as ImageRenderJob;
}

function harness(deps: { boundMs?: number; sendBoundMs?: number; ignoreAbort?: boolean } = {}) {
  const { ignoreAbort, ...limits } = deps;
  const renderer = scriptedRenderer(ignoreAbort);
  const failures: RenderFailureReport[] = [];
  const delivery = new ImageDelivery({
    renderer,
    reportFailure: (report) => failures.push(report),
    ...limits,
  });
  deliveries.push(delivery);
  const sent: { chatId: number; label: string; messageId: number }[] = [];
  const notes: { chatId: number; text: string }[] = [];
  const events: string[] = [];
  let nextMessageId = 100;
  /** A request for `chatId`; `payload` is what makes two requests of one slot identical or different. */
  const request = (
    chatId: number,
    slot: string,
    payload = 'v1',
    overrides: Partial<ImageDeliveryRequest> = {},
  ): ImageDeliveryRequest => ({
    chatId,
    language: 'en',
    kind: 'day',
    label: slot,
    slot,
    dataOwner: 1,
    buildJob: () => job('2026-04-07', payload),
    send: async () => {
      const messageId = nextMessageId++;
      sent.push({ chatId, label: slot, messageId });
      events.push(`photo:${slot}`);
      return messageId;
    },
    notify: async (text) => {
      notes.push({ chatId, text });
      events.push(`note:${slot}`);
    },
    ...overrides,
  });
  return { delivery, renderer, failures, sent, notes, events, request };
}

/** Every delivery of the running test: one still pending holds a render timer that must not outlive the test. */
let deliveries: ImageDelivery[];
let alerts: { text: string; source: string }[];
let outcomes: Record<string, unknown>[];
/** Every line the service logged at any level: [fields, message]. */
let logCalls: unknown[][];
let infoSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  alerts = [];
  deliveries = [];
  configureTimeoutReporter(new TimeoutReporter((text, source) => alerts.push({ text, source })));
  outcomes = [];
  logCalls = [];
  infoSpy = spyOn(imageLogger, 'info').mockImplementation(((obj: unknown, message?: string) => {
    logCalls.push([obj, message]);
    if (message === 'Image delivery outcome') outcomes.push(obj as Record<string, unknown>);
  }) as never);
  warnSpy = spyOn(imageLogger, 'warn').mockImplementation(((obj: unknown, message?: string) => {
    logCalls.push([obj, message]);
  }) as never);
  errorSpy = spyOn(imageLogger, 'error').mockImplementation(((obj: unknown, message?: string) => {
    logCalls.push([obj, message]);
  }) as never);
});

afterEach(async () => {
  await Promise.all(deliveries.map((delivery) => delivery.close(0)));
  configureTimeoutReporter(null);
  infoSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('enqueue returns at once; the picture follows', () => {
  test('a slow render does not hold the call, and a late finish is delivered after the text', async () => {
    const h = harness();
    const text = Promise.withResolvers<void>();

    const status = h.delivery.enqueue(h.request(1, 'day:a'));
    // The tool call has already returned: the model finishes its turn and the text goes out first.
    expect(status).toEqual({ status: 'queued' });
    expect(h.sent).toHaveLength(0);
    h.events.push('text');
    text.resolve();
    await text.promise;

    // 80 s later (the overloaded odroid, 2026-11-01) the worker finishes.
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.events).toEqual(['text', 'photo:day:a']);
    expect(h.notes).toHaveLength(0);
    expect(outcomes).toEqual([
      expect.objectContaining({ outcome: 'delivered', kind: 'day', chatId: 1, messageId: 100 }),
    ]);
  });

  test('the job carries the hard delivery bound as its expiry', async () => {
    const h = harness({ boundMs: 5_000 });
    const before = Date.now();
    h.delivery.enqueue(h.request(1, 'day:a'));
    await Promise.resolve();
    const { job: queued, options } = h.renderer.jobs[0]!;
    expect(queued.expiresAt).toBeGreaterThanOrEqual(before + 5_000);
    expect(queued.expiresAt).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(options?.timeoutMs).toBeLessThanOrEqual(5_000);
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();
  });

  describe('the outcome log lines hold no user text: not the label, not the table, not the note', () => {
    const SECRET = 'SECRET-TITLE';
    const mdTable = (): ImageRenderJob =>
      ({
        type: 'md-table',
        data: { title: SECRET, markdown: `| ${SECRET} |\n|---|\n| ${SECRET} |`, theme: { name: 'synthetic' } },
        userId: 1,
      }) as ImageRenderJob;
    // An Error's message and stack are not enumerable: spell them out, since pino's `err` serializer writes both.
    const logged = () =>
      JSON.stringify(logCalls, (_key, value) =>
        value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
      );

    test('a delivered picture', async () => {
      const h = harness();
      h.delivery.enqueue(h.request(1, `day:${SECRET}`, 'v1', { label: SECRET }));
      h.renderer.jobs[0]!.resolve(png());
      await h.delivery.whenIdle();
      expect(outcomes).toHaveLength(1);
      expect(logged()).not.toContain(SECRET);
    });

    test('a failed render', async () => {
      const h = harness();
      h.delivery.enqueue(h.request(1, `day:${SECRET}`, 'v1', { label: SECRET }));
      h.renderer.jobs[0]!.reject(new Error('worker crashed'));
      await h.delivery.whenIdle();
      expect(h.notes[0]!.text).toContain(SECRET); // the user's own note says what failed...
      expect(outcomes).toEqual([expect.objectContaining({ outcome: 'failed' })]);
      expect(logged()).not.toContain(SECRET); // ...the log never does
    });

    test('a timed-out render', async () => {
      const h = harness({ boundMs: 20 });
      h.delivery.enqueue(h.request(1, `day:${SECRET}`, 'v1', { label: SECRET }));
      await h.delivery.whenIdle();
      expect(h.notes[0]!.text).toContain(SECRET);
      expect(outcomes).toEqual([expect.objectContaining({ outcome: 'timed_out' })]);
      expect(logged()).not.toContain(SECRET);
    });

    test.each(['delivered', 'failed', 'timed_out'] as const)('a table with secret markdown: %s', async (outcome) => {
      const h = harness(outcome === 'timed_out' ? { boundMs: 20 } : {});
      h.delivery.enqueue(h.request(1, `table:${SECRET}`, 'v1', { kind: 'table', label: SECRET, buildJob: mdTable }));
      if (outcome === 'delivered') h.renderer.jobs[0]!.resolve(png());
      if (outcome === 'failed') h.renderer.jobs[0]!.reject(new Error('worker crashed'));
      await h.delivery.whenIdle();
      expect(outcomes).toEqual([expect.objectContaining({ outcome, kind: 'table', jobType: 'md-table' })]);
      expect(logged()).not.toContain(SECRET);
    });
  });
});

describe('a job that never finishes', () => {
  test('yields exactly one honest note, exactly one alert and no picture', async () => {
    const h = harness({ boundMs: 30 });
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { label: '2026-04-07' }));

    await h.delivery.whenIdle();

    expect(h.sent).toHaveLength(0);
    expect(h.notes).toEqual([{ chatId: 1, text: tr.imageNoteTimedOut('2026-04-07') }]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.source).toBe(TIMEOUT_ALERT_SOURCE);
    expect(alerts[0]!.text).toContain('Timeout (render)');
    expect(alerts[0]!.text).toContain('limitMs: 30');
    expect(alerts[0]!.text).toContain('unrecovered=1');
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'timed_out', phase: 'render' })]);
    // The abandoned job is withdrawn from the queue instead of rendering for nobody.
    expect(h.renderer.jobs[0]!.options?.signal?.aborted).toBe(true);
    expect(h.failures).toEqual([]);
  });

  test('a late finish after the bound never sends a picture on top of the note', async () => {
    const h = harness({ boundMs: 30, ignoreAbort: true });
    h.delivery.enqueue(h.request(1, 'day:a'));
    await h.delivery.whenIdle();
    expect(h.notes).toHaveLength(1);
    h.renderer.jobs[0]!.resolve(png()); // the worker finishes the job anyway
    await flush();
    expect(h.sent).toHaveLength(0);
    expect(h.notes).toHaveLength(1);
  });

  test('several timeouts in one window raise one aggregated alert (the reporter holds the rest back)', async () => {
    const h = harness({ boundMs: 20 });
    h.delivery.enqueue(h.request(1, 'day:a'));
    h.delivery.enqueue(h.request(2, 'day:b'));
    await h.delivery.whenIdle();
    expect(h.notes).toHaveLength(2);
    expect(alerts).toHaveLength(1);
  });
});

describe('a render that fails for another reason', () => {
  test('one note without the internal error text and one aggregated alert of its own kind', async () => {
    const h = harness();
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { label: '2026-04-07' }));
    h.renderer.jobs[0]!.reject(new Error('playwright: browser has been closed'));
    await h.delivery.whenIdle();

    expect(h.notes).toEqual([{ chatId: 1, text: tr.imageNoteFailed('2026-04-07') }]);
    expect(h.notes[0]!.text).not.toContain('playwright');
    expect(h.failures).toEqual([expect.objectContaining({ kind: 'day', jobType: 'daily-agenda', errorName: 'Error' })]);
    expect(alerts).toHaveLength(0);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'failed' })]);
  });

  test('a picture that is undeliverable by nature (too big) gets the localized note, never the internal English message, and is not an incident', async () => {
    const h = harness();
    h.delivery.enqueue(
      h.request(1, 'day:a', 'v1', {
        send: async () => {
          throw new AgendaImageError('Agenda PNG exceeds the 50 MB document limit. Choose a shorter date range.', true);
        },
      }),
    );
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.notes.map((n) => n.text)).toEqual([tr.imageNoteUndeliverable('day:a')]);
    expect(h.notes[0]!.text).not.toContain('Agenda');
    expect(h.failures).toEqual([]);
    expect(alerts).toHaveLength(0);
  });

  test.each([
    'Agenda renderer returned an invalid PNG.',
    'Agenda PNG has invalid dimensions.',
    'Agenda requires PNG document delivery, but document delivery is unavailable.',
  ])('a typed renderer or transport defect (%s) is not "too large": the user gets the failure note and the owner an alert', async (message) => {
    const h = harness();
    h.delivery.enqueue(
      h.request(1, 'day:a', 'v1', {
        send: async () => {
          throw new AgendaImageError(message);
        },
      }),
    );
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.notes.map((n) => n.text)).toEqual([tr.imageNoteFailed('day:a')]);
    expect(h.failures).toEqual([expect.objectContaining({ kind: 'day', errorName: 'Error' })]);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'failed', expected: false })]);
  });

  describe('a picture nobody can ask for again (the schedule comparison) does not offer it', () => {
    const conflictOverrides = { kind: 'conflict', label: 'schedule comparison' } as const;

    test('a failed render', async () => {
      const h = harness();
      h.delivery.enqueue(h.request(1, 'conflict:5', 'v1', conflictOverrides));
      h.renderer.jobs[0]!.reject(new Error('worker crashed'));
      await h.delivery.whenIdle();
      expect(h.notes).toEqual([{ chatId: 1, text: tr.imageNoteFailedFinal('schedule comparison') }]);
      expect(h.notes[0]!.text).not.toContain('Ask me again');
    });

    test('a timed-out render', async () => {
      const h = harness({ boundMs: 20 });
      h.delivery.enqueue(h.request(1, 'conflict:5', 'v1', conflictOverrides));
      await h.delivery.whenIdle();
      expect(h.notes).toEqual([{ chatId: 1, text: tr.imageNoteTimedOutFinal('schedule comparison') }]);
      expect(h.notes[0]!.text).not.toContain('Ask me again');
    });
  });

  test('an upload Telegram refused is a failure: one note, never logged as delivered', async () => {
    const h = harness();
    h.delivery.enqueue(
      h.request(1, 'day:a', 'v1', {
        send: async () => {
          throw new TelegramError(
            { ok: false, error_code: 429, description: 'Too Many Requests' },
            'sendPhoto',
            {} as never,
          );
        },
      }),
    );
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.notes).toHaveLength(1);
    expect(h.failures).toHaveLength(1);
    expect(outcomes.map((o) => o.outcome)).toEqual(['failed']);
  });

  test('a note that cannot be sent does not throw out of the delivery', async () => {
    const h = harness();
    const warn = spyOn(imageLogger, 'warn').mockImplementation((() => undefined) as never);
    try {
      h.delivery.enqueue(
        h.request(1, 'day:a', 'v1', {
          notify: async () => {
            throw new Error('chat not found');
          },
        }),
      );
      h.renderer.jobs[0]!.reject(new Error('boom'));
      await h.delivery.whenIdle();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('an upload that hangs holds no slot forever: one alert, one note that does not claim it failed', async () => {
    const h = harness({ sendBoundMs: 20 });
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { send: () => new Promise<number>(() => {}) }));
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.notes).toEqual([{ chatId: 1, text: tr.imageNoteUncertain('day:a') }]);
    expect(alerts).toHaveLength(1);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'timed_out', phase: 'send', delivery: 'unknown' })]);
  });
});

describe('two pictures in one chat', () => {
  test('the identical request twice is one render and one delivery', async () => {
    const h = harness();
    expect(h.delivery.enqueue(h.request(1, 'day:a'))).toEqual({ status: 'queued' });
    expect(h.delivery.enqueue(h.request(1, 'day:a'))).toEqual({ status: 'duplicate' });
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.renderer.renderDirect).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
  });

  test('the same picture in another chat is its own delivery', async () => {
    const h = harness();
    h.delivery.enqueue(h.request(1, 'day:a'));
    expect(h.delivery.enqueue(h.request(2, 'day:a'))).toEqual({ status: 'queued' });
    for (const pending of h.renderer.jobs) pending.resolve(png());
    await h.delivery.whenIdle();
    expect(h.sent.map((s) => s.chatId).sort()).toEqual([1, 2]);
  });

  test('a newer picture of the same slot replaces the older pending one: only the newest arrives, no note', async () => {
    const h = harness();
    h.delivery.enqueue(h.request(1, 'day:a', 'before-the-move'));
    h.delivery.enqueue(h.request(1, 'day:a', 'after-the-move'));
    await Promise.resolve();
    // The older one is withdrawn; the newer one finishes.
    expect(h.renderer.jobs[0]!.options?.signal?.aborted).toBe(true);
    h.renderer.jobs[1]!.resolve(png());
    await h.delivery.whenIdle();

    expect(h.sent).toHaveLength(1);
    expect(h.notes).toHaveLength(0);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['delivered', 'superseded']);
    expect(alerts).toHaveLength(0);
  });

  test('a superseded render that finishes anyway is not delivered', async () => {
    const h = harness({ ignoreAbort: true });
    const delivered: string[] = [];
    const withSend = (payload: string) =>
      h.request(1, 'day:a', payload, {
        send: async () => {
          delivered.push(payload);
          return 1;
        },
      });
    h.delivery.enqueue(withSend('v1'));
    h.delivery.enqueue(withSend('v2'));
    await Promise.resolve();
    h.renderer.jobs[0]!.resolve(png()); // a renderer that ignores the abort
    h.renderer.jobs[1]!.resolve(png());
    await h.delivery.whenIdle();
    expect(delivered).toEqual(['v2']);
  });

  test('concurrency per chat is bounded: the pending cap is honest, other chats are unaffected', async () => {
    const h = harness();
    for (let i = 0; i < MAX_PENDING_PER_CHAT; i++) {
      expect(h.delivery.enqueue(h.request(1, `day:${i}`, `p${i}`))).toEqual({ status: 'queued' });
    }
    expect(h.delivery.enqueue(h.request(1, 'day:extra', 'extra'))).toEqual({ status: 'busy' });
    expect(h.delivery.enqueue(h.request(2, 'day:other'))).toEqual({ status: 'queued' });
    expect(h.renderer.renderDirect).toHaveBeenCalledTimes(MAX_PENDING_PER_CHAT + 1);

    // A finished picture frees its place.
    h.renderer.jobs[0]!.resolve(png());
    await flush();
    expect(h.delivery.enqueue(h.request(1, 'day:extra', 'extra'))).toEqual({ status: 'queued' });
    for (const pending of h.renderer.jobs) pending.resolve(png());
    await h.delivery.whenIdle();
  });

  test("the schedule comparisons of accepted invitations have their own per-chat limit, apart from the chat's own pictures", async () => {
    const h = harness();
    const conflict = (id: number) =>
      h.request(1, `conflict:${id}`, `c${id}`, { kind: 'conflict', label: 'schedule comparison' });
    // More guests accept within one render than the chat's own limit: each comparison still has its place.
    for (let i = 0; i < MAX_PENDING_CONFLICT_PER_CHAT; i++) {
      expect(h.delivery.enqueue(conflict(i))).toEqual({ status: 'queued' });
    }
    // Their own limit is bounded too, so one chat cannot take the whole bot-wide budget.
    expect(h.delivery.enqueue(conflict(99))).toEqual({ status: 'busy' });
    // The inviter's own pictures keep their full place in the chat whatever the comparisons hold.
    for (let i = 0; i < MAX_PENDING_PER_CHAT; i++) {
      expect(h.delivery.enqueue(h.request(1, `day:${i}`, `p${i}`))).toEqual({ status: 'queued' });
    }
    expect(h.delivery.enqueue(h.request(1, 'day:extra', 'extra'))).toEqual({ status: 'busy' });

    for (const pending of h.renderer.jobs) pending.resolve(png());
    await h.delivery.whenIdle();
    expect(h.sent).toHaveLength(MAX_PENDING_CONFLICT_PER_CHAT + MAX_PENDING_PER_CHAT);
  });

  test("the schedule comparisons are bounded bot-wide as well: the chats' own pictures always keep the other half", async () => {
    const h = harness();
    const conflict = (chat: number, id: number) =>
      h.request(chat, `conflict:${chat}:${id}`, `c${id}`, { kind: 'conflict', label: 'schedule comparison' });
    let queued = 0;
    for (let chat = 1; queued < MAX_PENDING_CONFLICT_TOTAL; chat++) {
      for (let i = 0; i < MAX_PENDING_CONFLICT_PER_CHAT && queued < MAX_PENDING_CONFLICT_TOTAL; i++, queued++) {
        expect(h.delivery.enqueue(conflict(chat, i))).toEqual({ status: 'queued' });
      }
    }
    expect(h.delivery.enqueue(conflict(50, 0))).toEqual({ status: 'busy' });
    // Other chats' own pictures still fit in the rest of the bot-wide budget.
    for (let chat = 100; chat < 100 + MAX_PENDING_TOTAL - MAX_PENDING_CONFLICT_TOTAL; chat++) {
      expect(h.delivery.enqueue(h.request(chat, 'day:a'))).toEqual({ status: 'queued' });
    }
    for (const pending of h.renderer.jobs) pending.resolve(png());
    await h.delivery.whenIdle();
  });

  test('the shared host is bounded too: pending pictures across chats are capped', async () => {
    const h = harness();
    for (let chat = 1; chat <= MAX_PENDING_TOTAL; chat++) {
      expect(h.delivery.enqueue(h.request(chat, 'day:a'))).toEqual({ status: 'queued' });
    }
    expect(h.delivery.enqueue(h.request(999, 'day:a'))).toEqual({ status: 'busy' });
    for (const pending of h.renderer.jobs) pending.resolve(png());
    await h.delivery.whenIdle();
  });
});

describe('a failure note that hangs', () => {
  test('is given up on after the send bound and does not count against the bot-wide limit meanwhile', async () => {
    const h = harness({ sendBoundMs: 40 });
    // The first picture fails, and its note never returns (a hung or flood-waiting Telegram call).
    h.delivery.enqueue(h.request(1, 'day:stuck', 'v1', { notify: () => new Promise(() => {}) }));
    h.renderer.jobs[0]!.reject(new Error('worker crashed'));
    await flush();

    // Its delivery has ended: it holds no place, so MAX_PENDING_TOTAL more pictures still fit.
    for (let chat = 2; chat < 2 + MAX_PENDING_TOTAL; chat++) {
      expect(h.delivery.enqueue(h.request(chat, 'day:a'))).toEqual({ status: 'queued' });
    }
    for (const pending of h.renderer.jobs.slice(1)) pending.resolve(png());

    // And the hung note itself ends within the bound instead of holding the delivery forever.
    await h.delivery.whenIdle();
    expect(logCalls.some(([, message]) => message === 'Image delivery: the failure note could not be sent')).toBe(true);
  });
});

describe('the user sends a new message before the picture arrives', () => {
  test('a calendar write while the picture renders: it is rebuilt once from the current data', async () => {
    const h = harness();
    let version = 'before';
    h.delivery.enqueue(h.request(1, 'day:a', 'ignored', { buildJob: () => job('2026-04-07', version) }));
    await Promise.resolve();

    version = 'after'; // the next message moved the event
    h.delivery.eventsChanged(1);
    h.renderer.jobs[0]!.resolve(png());
    await flush();

    expect(h.sent).toHaveLength(0);
    expect(h.renderer.jobs).toHaveLength(2);
    expect(JSON.stringify(h.renderer.jobs[1]!.job)).toContain('after');
    h.renderer.jobs[1]!.resolve(png());
    await h.delivery.whenIdle();
    expect(h.sent).toHaveLength(1);
  });

  test('a rebuild happens once only: a second write does not loop the render', async () => {
    const h = harness();
    let version = 'v1';
    h.delivery.enqueue(h.request(1, 'day:a', 'ignored', { buildJob: () => job('2026-04-07', version) }));
    await Promise.resolve();
    version = 'v2';
    h.delivery.eventsChanged(1);
    h.renderer.jobs[0]!.resolve(png());
    await flush();
    version = 'v3';
    h.delivery.eventsChanged(1);
    h.renderer.jobs[1]!.resolve(png());
    await h.delivery.whenIdle();
    expect(h.renderer.renderDirect).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveLength(1);
  });

  test("another user's write, or a write before the picture was queued, leaves it alone", async () => {
    const h = harness();
    h.delivery.eventsChanged(1); // before enqueue
    h.delivery.enqueue(h.request(1, 'day:a'));
    await Promise.resolve();
    h.delivery.eventsChanged(2);
    h.renderer.jobs[0]!.resolve(png());
    await h.delivery.whenIdle();
    expect(h.renderer.renderDirect).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveLength(1);
  });

  test('a group picture is stale after any write; a table never is', async () => {
    const h = harness();
    let version = 'g1';
    h.delivery.enqueue(
      h.request(1, 'week:group', 'ignored', { dataOwner: 'group', buildJob: () => job('2026-04-07', version) }),
    );
    h.delivery.enqueue(
      h.request(1, 'table:x', 't', { kind: 'table', dataOwner: undefined, buildJob: () => job('2026-04-08', version) }),
    );
    await Promise.resolve();
    version = 'g2';
    h.delivery.eventsChanged(77);
    h.renderer.jobs[0]!.resolve(png());
    h.renderer.jobs[1]!.resolve(png());
    await flush();
    // group: rebuilt (a third job); table: delivered as is.
    expect(h.renderer.renderDirect).toHaveBeenCalledTimes(3);
    h.renderer.jobs[2]!.resolve(png());
    await h.delivery.whenIdle();
    expect(h.sent.map((s) => s.label).sort()).toEqual(['table:x', 'week:group']);
  });

  describe('a picture of today carries the clock, which is not what it shows', () => {
    const todayJob =
      (minutes: number, holidayName = ''): (() => ImageRenderJob) =>
      () => {
        const base = job('2026-04-07', holidayName);
        return { ...base, data: { ...base.data, relativeDay: 'Today', currentTimeMinutes: minutes } } as ImageRenderJob;
      };

    test('the same picture asked again a minute later is the same delivery: one render, one picture', async () => {
      const h = harness();
      expect(h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: todayJob(600) }))).toEqual({ status: 'queued' });
      expect(h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: todayJob(601) }))).toEqual({
        status: 'duplicate',
      });
      h.renderer.jobs[0]!.resolve(png());
      await h.delivery.whenIdle();

      expect(h.renderer.renderDirect).toHaveBeenCalledTimes(1);
      expect(h.sent).toHaveLength(1);
    });

    test('a write that changed nothing the picture shows does not render it again, though the minute moved on', async () => {
      const h = harness();
      let minutes = 600;
      h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: () => todayJob(minutes)() }));
      await Promise.resolve();
      minutes = 601; // the render takes longer than a minute
      h.delivery.eventsChanged(1); // an event on another day
      h.renderer.jobs[0]!.resolve(png());
      await h.delivery.whenIdle();

      expect(h.renderer.renderDirect).toHaveBeenCalledTimes(1);
      expect(h.sent).toHaveLength(1);
    });

    test('a real change to the day is still a different picture: it supersedes the older one', async () => {
      const h = harness();
      expect(h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: todayJob(600, 'before') }))).toEqual({
        status: 'queued',
      });
      expect(h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: todayJob(601, 'after') }))).toEqual({
        status: 'queued',
      });
      await Promise.resolve();
      expect(h.renderer.jobs[0]!.options?.signal?.aborted).toBe(true);
      h.renderer.jobs[1]!.resolve(png());
      await h.delivery.whenIdle();
      expect(h.sent).toHaveLength(1);
    });

    test('a write that changed what the picture shows still rebuilds it, whatever the minute', async () => {
      const h = harness();
      let holidayName = 'before';
      h.delivery.enqueue(h.request(1, 'day:a', 'x', { buildJob: () => todayJob(600, holidayName)() }));
      await Promise.resolve();
      holidayName = 'after';
      h.delivery.eventsChanged(1);
      h.renderer.jobs[0]!.resolve(png());
      await flush();

      expect(h.renderer.renderDirect).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(h.renderer.jobs[1]!.job)).toContain('after');
      h.renderer.jobs[1]!.resolve(png());
      await h.delivery.whenIdle();
      expect(h.sent).toHaveLength(1);
    });
  });
});

describe('shutdown while pictures are pending', () => {
  test('a pending render is cancelled, the user is told once, and it is logged as interrupted, never delivered', async () => {
    const h = harness({ ignoreAbort: true });
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { label: '2026-04-07' }));
    h.delivery.enqueue(h.request(2, 'day:b', 'v1', { label: 'Table' }));
    await Promise.resolve();

    await h.delivery.close();

    expect(h.notes.map((n) => n.text).sort()).toEqual(
      [tr.imageNoteInterrupted('2026-04-07'), tr.imageNoteInterrupted('Table')].sort(),
    );
    expect(h.renderer.jobs.every((pending) => pending.options?.signal?.aborted)).toBe(true);
    expect(outcomes.map((o) => o.outcome)).toEqual(['interrupted', 'interrupted']);
    // A completion that arrives after the close finds nobody to send to.
    for (const pending of h.renderer.jobs) pending.resolve(png());
    await flush();
    expect(h.sent).toHaveLength(0);
    expect(h.notes).toHaveLength(2);
    expect(alerts).toHaveLength(0);
  });

  test('nothing is queued after the close', async () => {
    const h = harness();
    await h.delivery.close();
    expect(h.delivery.enqueue(h.request(1, 'day:a'))).toEqual({ status: 'closed' });
    expect(h.renderer.renderDirect).not.toHaveBeenCalled();
  });

  test('the notes are bounded by the shutdown budget: a stuck Telegram call cannot hold the exit', async () => {
    const h = harness();
    const warn = spyOn(imageLogger, 'warn').mockImplementation((() => undefined) as never);
    try {
      h.delivery.enqueue(h.request(1, 'day:a', 'v1', { notify: () => new Promise<void>(() => {}) }));
      await Promise.resolve();
      const started = Date.now();
      await h.delivery.close(40);
      expect(Date.now() - started).toBeLessThan(500);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(outcomes.map((o) => o.outcome)).toEqual(['interrupted']);
    } finally {
      warn.mockRestore();
    }
  });

  test('a picture already uploading gets a grace; if it lands it is delivered, with no false note', async () => {
    const h = harness();
    const upload = Promise.withResolvers<number>();
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { send: () => upload.promise }));
    h.renderer.jobs[0]!.resolve(png());
    await flush();

    const closing = h.delivery.close(200);
    upload.resolve(555);
    await closing;

    expect(h.notes).toHaveLength(0);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'delivered', messageId: 555 })]);
  });

  test('an upload that does not finish within the grace is logged unknown, never as delivered, and not announced as failed', async () => {
    const h = harness();
    h.delivery.enqueue(h.request(1, 'day:a', 'v1', { send: () => new Promise<number>(() => {}) }));
    h.renderer.jobs[0]!.resolve(png());
    await flush();

    await h.delivery.close(30);

    expect(h.notes).toHaveLength(0);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'interrupted', delivery: 'unknown' })]);
  });
});
