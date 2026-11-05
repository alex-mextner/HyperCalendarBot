// Pictures survive a process death: the delivery record is written before each step and the next start
// reconciles it (deliver once / expire with one note / mark unknown and never re-send). A fake BullMQ
// (a job-id keyed map shared by "both processes") and fake Telegram functions; the store is the real
// repository over SQLite with the real migration.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ImageDeliveryRepository } from '../../../src/database/repositories/image-delivery.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import {
  ImageDelivery,
  type ImageDeliveryDeps,
  type ImageDeliveryRequest,
  type RenderFailureReport,
} from '../../../src/services/image/image-delivery.ts';
import {
  RenderAbortedError,
  type RenderOptions,
  RenderTimeoutError,
} from '../../../src/services/image/render-service.ts';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { imageLogger } from '../../../src/utils/logger.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { png } from '../../fixtures/png.ts';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const tr = t('ru').aiTools.meta;

/** What survives a restart besides SQLite: Redis. Adding a job id Redis already has returns that job. */
class FakeQueue {
  readonly jobs = new Map<string, { job: ImageRenderJob; result: PromiseWithResolvers<Buffer>; adds: number }>();
  renderDirect = (job: ImageRenderJob, options?: RenderOptions): Promise<Buffer> => {
    const jobId = options?.jobId ?? 'no-id';
    const known = this.jobs.get(jobId) ?? { job, result: Promise.withResolvers<Buffer>(), adds: 0 };
    known.adds++;
    this.jobs.set(jobId, known);
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    options?.signal?.addEventListener('abort', () => reject(new RenderAbortedError()), { once: true });
    known.result.promise.then(resolve, reject);
    return promise;
  };
}

/** A process that dies right after queueing: Redis has the job, nobody in this process waits for it. */
const dying = (q: FakeQueue) => ({
  renderDirect: (job: ImageRenderJob, options?: RenderOptions) => {
    void q.renderDirect(job, options).catch(() => {});
    return new Promise<Buffer>(() => {});
  },
});

let db: Database;
let store: ImageDeliveryRepository;
let queue: FakeQueue;
let alerts: string[];
let outcomes: Record<string, unknown>[];
let failures: RenderFailureReport[];
let infoSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
/** Every delivery the test created: each one still pending holds a render or an upload timer. */
let deliveries: ImageDelivery[];

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  store = new ImageDeliveryRepository(db);
  queue = new FakeQueue();
  alerts = [];
  outcomes = [];
  failures = [];
  deliveries = [];
  configureTimeoutReporter(new TimeoutReporter((text) => alerts.push(text)));
  infoSpy = spyOn(imageLogger, 'info').mockImplementation(((obj: unknown, message?: string) => {
    if (message === 'Image delivery outcome') outcomes.push(obj as Record<string, unknown>);
  }) as never);
  errorSpy = spyOn(imageLogger, 'error').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  // Cancel what is still pending BEFORE the database closes: an abandoned delivery keeps its 30 s upload and
  // 150 s render timers, which would otherwise fire inside whichever test file runs next (a stray outcome
  // log line, a timeout alert) and write to a closed database.
  await Promise.all(deliveries.map((delivery) => delivery.close(0)));
  configureTimeoutReporter(null);
  infoSpy.mockRestore();
  errorSpy.mockRestore();
  db.close();
});

function track(delivery: ImageDelivery): ImageDelivery {
  deliveries.push(delivery);
  return delivery;
}

/** One bot process: its own ImageDelivery over the shared SQLite and Redis. */
function startProcess(now?: () => number, dies = false, extra: Partial<ImageDeliveryDeps> = {}) {
  const delivery = track(
    new ImageDelivery({
      renderer: dies ? dying(queue) : queue,
      store,
      reportFailure: (report) => failures.push(report),
      now,
      ...extra,
    }),
  );
  const sentImages: { chatId: number; language: string }[] = [];
  const notes: { chatId: number; text: string }[] = [];
  delivery.attachTransport({
    sendImage: async (chatId, _png, language) => {
      sentImages.push({ chatId, language });
      return 500 + sentImages.length;
    },
    notify: async (chatId, text) => {
      notes.push({ chatId, text });
    },
  });
  return { delivery, sentImages, notes };
}

function request(overrides: Partial<ImageDeliveryRequest> = {}): ImageDeliveryRequest {
  return {
    chatId: 7,
    language: 'ru',
    kind: 'day',
    label: '2026-11-02',
    slot: 'day:user:1:2026-11-02',
    requestId: 900,
    dataOwner: 1,
    buildJob: () =>
      ({ type: 'daily-agenda', data: { date: '2026-11-02', theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob,
    send: async () => 1,
    notify: async () => {},
    ...overrides,
  };
}

const onlyRow = () => {
  const rows = db
    .query<{ id: string; state: string; message_id: number | null; job_json: string | null }, []>(
      'SELECT * FROM image_deliveries',
    )
    .all();
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

describe('a delivery is recorded before it acts', () => {
  test('queued at enqueue, then rendered and sending before the upload, delivered with the Telegram message id', async () => {
    const seen: string[] = [];
    const process1 = startProcess();
    process1.delivery.enqueue(
      request({
        send: async () => {
          seen.push(onlyRow().state); // what a kill at this instant would leave behind
          return 4242;
        },
      }),
    );
    expect(onlyRow().state).toBe('queued');
    expect(onlyRow().job_json).not.toBeNull();
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process1.delivery.whenIdle();

    expect(seen).toEqual(['sending']);
    expect(onlyRow()).toMatchObject({ state: 'delivered', message_id: 4242, job_json: null });
  });

  test('the BullMQ job id is the deterministic delivery id, and the same request twice is one record', async () => {
    const process1 = startProcess();
    expect(process1.delivery.enqueue(request())).toEqual({ status: 'queued' });
    expect(process1.delivery.enqueue(request())).toEqual({ status: 'duplicate' });
    expect([...queue.jobs.keys()]).toEqual([onlyRow().id]);
    expect(onlyRow().id).toStartWith('img-');
    process1.delivery.attachTransport({ sendImage: async () => 1, notify: async () => {} });
    // Another process (a restart) enqueueing the identical live request is also recognised.
    const process2 = startProcess();
    expect(process2.delivery.enqueue(request())).toEqual({ status: 'duplicate' });
  });
});

describe('crash after the render, before the send', () => {
  test('the next start delivers the finished picture exactly once', async () => {
    const process1 = startProcess(undefined, true);
    process1.delivery.enqueue(request());
    const [jobId] = [...queue.jobs.keys()];
    // process 1 dies here (never closed, its wait is abandoned) while the worker finishes the job.
    queue.jobs.get(jobId!)!.result.resolve(png());

    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();

    expect(process2.sentImages).toEqual([{ chatId: 7, language: 'ru' }]);
    expect(process2.notes).toHaveLength(0);
    expect(onlyRow()).toMatchObject({ state: 'delivered', message_id: 501 });
    expect(outcomes.filter((o) => o.outcome === 'delivered')).toHaveLength(1);
    // The same job id was awaited again, not a second render.
    expect(queue.jobs.get(jobId!)!.adds).toBe(2);
    expect(queue.jobs.size).toBe(1);

    // A further restart finds nothing to do.
    const process3 = startProcess();
    await process3.delivery.reconcile();
    await process3.delivery.whenIdle();
    expect(process3.sentImages).toHaveLength(0);
    expect(process3.notes).toHaveLength(0);
  });

  test('a render still running when the bot returns is waited for, not duplicated', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.sentImages).toHaveLength(0);
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process2.delivery.whenIdle();
    expect(process2.sentImages).toHaveLength(1);
    expect(queue.jobs.size).toBe(1);
  });

  describe('killed between the end of the render and the claim on the send (state rendered)', () => {
    /** What the store holds when the process died after `advance(rendered)` and before `advance(sending)`. */
    function killedAfterRender() {
      startProcess(undefined, true).delivery.enqueue(request());
      db.run("UPDATE image_deliveries SET state = 'rendered'");
      expect(onlyRow().state).toBe('rendered');
      [...queue.jobs.values()][0]!.result.resolve(png()); // the worker finished the job while the bot was down
    }

    test('within the bound the next start delivers the picture once, with no note', async () => {
      killedAfterRender();
      const process2 = startProcess();
      await process2.delivery.reconcile();
      await process2.delivery.whenIdle();

      expect(process2.sentImages).toEqual([{ chatId: 7, language: 'ru' }]);
      expect(process2.notes).toEqual([]);
      expect(onlyRow()).toMatchObject({ state: 'delivered', message_id: 501, job_json: null });

      const process3 = startProcess();
      await process3.delivery.reconcile();
      expect(process3.sentImages).toHaveLength(0); // never twice
    });

    test('past the bound it expires with one "the bot was restarting" note and no timeout alert, and no picture', async () => {
      killedAfterRender();
      const late = () => Date.now() + 5 * 60_000; // past the 150 s bound, within the ten minutes a user still waits
      const process2 = startProcess(late);
      await process2.delivery.reconcile();
      await process2.delivery.whenIdle();

      expect(process2.sentImages).toEqual([]);
      // A row still `queued` past its bound means the previous process stopped before the bound: downtime, not a slow render.
      expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteInterrupted('2026-11-02') }]);
      expect(alerts).toEqual([]);
      expect(onlyRow()).toMatchObject({ state: 'expired', note_sent: 1, job_json: null });

      const process3 = startProcess(late);
      await process3.delivery.reconcile();
      expect(process3.notes).toEqual([]);
      expect(alerts).toEqual([]);
    });
  });
});

describe('crash after the send started, before it was recorded', () => {
  test('the picture may have landed: marked unknown, never re-sent, the user is not told it failed', async () => {
    const process1 = startProcess();
    process1.delivery.enqueue(request({ send: () => new Promise<number>(() => {}) })); // killed mid-upload
    [...queue.jobs.values()][0]!.result.resolve(png());
    await flush();
    expect(onlyRow().state).toBe('sending');

    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();

    expect(onlyRow().state).toBe('unknown');
    expect(process2.sentImages).toHaveLength(0);
    expect(process2.notes).toHaveLength(0);
    // The repair flow hears of the uncertainty, once.
    expect(failures).toEqual([expect.objectContaining({ kind: 'day', errorName: 'UncertainSend' })]);
    expect(outcomes).toContainEqual(
      expect.objectContaining({ outcome: 'unknown', delivery: 'unknown', recovered: true }),
    );

    const process3 = startProcess();
    await process3.delivery.reconcile();
    expect(process3.sentImages).toHaveLength(0);
    expect(failures).toHaveLength(1);
  });
});

describe('an expired delivery', () => {
  test('one honest note, no timeout alert, recorded as expired; a later restart says nothing more', async () => {
    const created = Date.now();
    startProcess(undefined, true).delivery.enqueue(request()); // the bot dies right after queueing
    const late = () => created + 10 * 60_000; // it comes back far past the 150 s bound

    const process2 = startProcess(late);
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();

    expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteInterrupted('2026-11-02') }]);
    expect(process2.sentImages).toHaveLength(0);
    expect(alerts).toEqual([]);
    expect(onlyRow()).toMatchObject({ state: 'expired', job_json: null });
    expect(db.query<{ note_sent: number }, []>('SELECT note_sent FROM image_deliveries').get()?.note_sent).toBe(1);

    const process3 = startProcess(late);
    await process3.delivery.reconcile();
    expect(process3.notes).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  test('an expiry the previous process recorded itself (it died before telling the user) is still a slow render', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    db.run("UPDATE image_deliveries SET state = 'expired', job_json = NULL, note_sent = 0");
    const process2 = startProcess();
    await process2.delivery.reconcile();

    expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteTimedOut('2026-11-02') }]);
  });

  test('a record without its payload cannot be rendered: expired, not guessed', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    db.run('UPDATE image_deliveries SET job_json = NULL');
    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(onlyRow().state).toBe('expired');
    expect(process2.notes).toHaveLength(1);
  });

  test('the schedule comparison, which nobody can ask for again, is told without the offer to ask again', async () => {
    startProcess(undefined, true).delivery.enqueue(request({ kind: 'conflict', label: 'сравнение расписаний' }));
    const process2 = startProcess(() => Date.now() + 5 * 60_000);
    await process2.delivery.reconcile();
    expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteInterruptedFinal('сравнение расписаний') }]);
    expect(process2.notes[0]!.text).not.toContain('ещё раз');
  });
});

describe('a delivery that ended without its user being told', () => {
  test('the next start sends the one missing note, and no more after that', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    // The previous process recorded the failure and died before the note went out.
    db.run("UPDATE image_deliveries SET state = 'failed', job_json = NULL, note_sent = 0");

    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteFailed('2026-11-02') }]);

    const process3 = startProcess();
    await process3.delivery.reconcile();
    expect(process3.notes).toHaveLength(0);
  });

  test('an uncertain send is never reported to the user as a failure', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    db.run("UPDATE image_deliveries SET state = 'unknown', job_json = NULL, note_sent = 0");
    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.notes).toHaveLength(0);
  });
});

describe('the claim on the send', () => {
  test('a delivery another attempt already claimed is not uploaded again', async () => {
    const send = mock(async () => 1);
    const process1 = startProcess();
    process1.delivery.enqueue(request({ send }));
    db.run("UPDATE image_deliveries SET state = 'sending'"); // a redelivered attempt got there first
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process1.delivery.whenIdle();
    expect(send).not.toHaveBeenCalled();
    expect(onlyRow().state).toBe('sending');
    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'claimed_elsewhere', delivery: 'not_started' })]);
  });
});

describe('graceful shutdown with a durable record', () => {
  test('no note is sent: the queued job is kept and the next start delivers the picture', async () => {
    const process1 = startProcess();
    const requestNotes: string[] = [];
    // A live delivery notifies through its own request closure, so that is the channel to watch.
    process1.delivery.enqueue(request({ notify: async (text) => void requestNotes.push(text) }));
    const notes: string[] = [];
    process1.delivery.attachTransport({ sendImage: async () => 1, notify: async (_c, text) => void notes.push(text) });
    await process1.delivery.close();
    await process1.delivery.whenIdle();

    expect(requestNotes).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(onlyRow().state).toBe('queued');
    expect(outcomes).toContainEqual(expect.objectContaining({ outcome: 'interrupted', resumable: true }));

    [...queue.jobs.values()][0]!.result.resolve(png());
    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();
    expect(process2.sentImages).toHaveLength(1);
    expect(onlyRow().state).toBe('delivered');
  });

  test('a shutdown right after a newer picture replaced the older one keeps the older record superseded: the restart delivers only the newest', async () => {
    const dayJob = (date: string) => () =>
      ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;
    const process1 = startProcess();
    process1.delivery.enqueue(request({ requestId: 1, buildJob: dayJob('2026-11-02') }));
    process1.delivery.enqueue(request({ requestId: 2, buildJob: dayJob('2026-11-03') })); // same slot, newer data
    await process1.delivery.close(0); // before the older run has unwound
    await process1.delivery.whenIdle();

    const states = db.query<{ state: string }, []>('SELECT state FROM image_deliveries').all();
    expect(states.map((row) => row.state).sort()).toEqual(['queued', 'superseded']);

    for (const job of queue.jobs.values()) job.result.resolve(png());
    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();
    expect(process2.sentImages).toHaveLength(1);
  });
});

describe('the same request after its delivery ended', () => {
  // `superseded` is not here: that picture never uploaded and nobody was told, so the same request goes on
  // (see 'a request replaced within its own turn and asked for again goes on').
  test.each([
    'delivered',
    'failed',
    'expired',
    'unknown',
  ])('a request that already ended %s is settled: nothing is queued and it is not called "being prepared"', (state) => {
    const process1 = startProcess();
    expect(process1.delivery.enqueue(request())).toEqual({ status: 'queued' });
    db.run('UPDATE image_deliveries SET state = ?, job_json = NULL', [state]);

    const process2 = startProcess();
    expect(process2.delivery.enqueue(request())).toEqual({ status: 'settled' });
    expect([...queue.jobs.values()].map((job) => job.adds)).toEqual([1]);
    expect(onlyRow().state).toBe(state);
  });

  test('a different message asking for the same picture is a new delivery', () => {
    const process1 = startProcess();
    process1.delivery.enqueue(request({ requestId: 900 }));
    db.run("UPDATE image_deliveries SET state = 'delivered', job_json = NULL");
    const process2 = startProcess();
    expect(process2.delivery.enqueue(request({ requestId: 901 }))).toEqual({ status: 'queued' });
  });
});

describe('supersede and rebuild with a durable record', () => {
  const dayJob = (date: string) => () =>
    ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;

  test('a newer picture of the slot ends the older record as superseded, so a restart never delivers both', async () => {
    const process1 = startProcess();
    const sends: string[] = [];
    const record = (who: string, id: number) => async () => {
      sends.push(who);
      return id;
    };
    process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02'), send: record('older', 1) }));
    process1.delivery.enqueue(request({ requestId: 901, buildJob: dayJob('2026-11-03'), send: record('newer', 2) }));
    await flush(); // the older wait ends on its abort and records `superseded`
    const rows = db.query<{ state: string }, []>('SELECT state FROM image_deliveries').all();
    expect(rows.map((row) => row.state).sort()).toEqual(['queued', 'superseded']);

    for (const job of queue.jobs.values()) job.result.resolve(png());
    await process1.delivery.whenIdle();
    expect(sends).toEqual(['newer']);
    expect(db.query<{ state: string }, []>('SELECT state FROM image_deliveries ORDER BY state').all()).toEqual([
      { state: 'delivered' },
      { state: 'superseded' },
    ]);

    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.sentImages).toHaveLength(0);
    expect(process2.notes).toHaveLength(0); // a superseded record never earns a failure note
  });

  test('a request replaced within its own turn and asked for again goes on: it is not told "already handled"', async () => {
    const process1 = startProcess();
    const sends: string[] = [];
    const record = (who: string) => async () => {
      sends.push(who);
      return 1;
    };
    // One message: the picture, the data changes, the picture again, the data goes back, the picture a third time.
    expect(
      process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02'), send: record('first') })),
    ).toEqual({ status: 'queued' });
    expect(
      process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-03'), send: record('second') })),
    ).toEqual({ status: 'queued' });
    await flush(); // the first one ends `superseded`
    expect(
      process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02'), send: record('third') })),
    ).toEqual({ status: 'queued' });

    for (const job of queue.jobs.values()) job.result.resolve(png());
    await process1.delivery.whenIdle();
    expect(sends).toEqual(['third']); // the newest one only
    expect(
      db
        .query<{ state: string }, []>('SELECT state FROM image_deliveries ORDER BY state')
        .all()
        .map((row) => row.state),
    ).toEqual(['delivered', 'superseded']);
  });

  test('a replaced delivery that is still unwinding makes the same request again a duplicate, not a second row', async () => {
    const process1 = startProcess();
    process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02') }));
    process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-03') })); // supersedes, not yet unwound
    expect(process1.delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02') }))).toEqual({
      status: 'duplicate',
    });
  });

  test('a redelivered update whose picture already ended is settled even when the chat is at its limit', async () => {
    const process1 = startProcess();
    expect(process1.delivery.enqueue(request({ requestId: 900, slot: 'day:a' }))).toEqual({ status: 'queued' });
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process1.delivery.whenIdle();
    // Two other pictures now fill the chat's places.
    process1.delivery.enqueue(request({ requestId: 901, slot: 'day:b', buildJob: dayJob('2026-11-04') }));
    process1.delivery.enqueue(request({ requestId: 902, slot: 'day:c', buildJob: dayJob('2026-11-05') }));
    expect(
      process1.delivery.enqueue(request({ requestId: 903, slot: 'day:d', buildJob: dayJob('2026-11-06') })),
    ).toEqual({ status: 'busy' });

    expect(process1.delivery.enqueue(request({ requestId: 900, slot: 'day:a' }))).toEqual({ status: 'settled' });
  });

  test('a calendar write while it renders rebuilds under a NEW job id, so the stale finished job is not reused', async () => {
    const process1 = startProcess();
    let date = '2026-11-02';
    const send = mock(async () => 7);
    process1.delivery.enqueue(request({ buildJob: () => dayJob(date)(), send }));
    const [firstId] = [...queue.jobs.keys()];

    date = '2026-11-03'; // the next message moved the event
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png());
    await flush();

    expect(send).not.toHaveBeenCalled();
    const rebuiltId = `${firstId}-r1`;
    expect([...queue.jobs.keys()]).toEqual([firstId!, rebuiltId]);
    expect(JSON.stringify(queue.jobs.get(rebuiltId)!.job.data)).toContain('2026-11-03');

    queue.jobs.get(rebuiltId)!.result.resolve(png());
    await process1.delivery.whenIdle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onlyRow()).toMatchObject({ state: 'delivered', message_id: 7 });
  });

  test('a finished picture is still sent when the rebuild cannot finish', async () => {
    const process1 = startProcess();
    const send = mock(async () => 8);
    let date = '2026-11-02';
    const requestNotes: string[] = [];
    process1.delivery.enqueue(
      request({
        buildJob: () => dayJob(date)(),
        send,
        notify: async (text) => void requestNotes.push(text),
      }),
    );
    const [firstId] = [...queue.jobs.keys()];
    date = '2026-11-03';
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png());
    await flush();
    queue.jobs.get(`${firstId}-r1`)!.result.reject(new Error('worker crashed')); // the rebuild fails
    await process1.delivery.whenIdle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe('delivered');
    expect(requestNotes).toHaveLength(0);
  });

  test('a rebuild cut by the render bound still sends the earlier picture and is reported as a recovered timeout', async () => {
    const process1 = startProcess();
    const send = mock(async () => 8);
    let date = '2026-11-02';
    process1.delivery.enqueue(request({ buildJob: () => dayJob(date)(), send }));
    const [firstId] = [...queue.jobs.keys()];
    date = '2026-11-03';
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png());
    await flush();
    queue.jobs.get(`${firstId}-r1`)!.result.reject(new RenderTimeoutError(120_000, 150_000));
    await process1.delivery.whenIdle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe('delivered');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Timeout (render)');
    expect(alerts[0]).toContain('recovered=1');
  });

  test('a write that lands with too little of the bound left sends the picture as rendered', async () => {
    let nowMs = 1_000_000;
    const process1 = startProcess(() => nowMs);
    const send = mock(async () => 9);
    process1.delivery.enqueue(request({ send }));
    const [firstId] = [...queue.jobs.keys()];
    nowMs += 120_000; // the render took 120 s of the 150 s bound
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png());
    await process1.delivery.whenIdle();

    expect([...queue.jobs.keys()]).toEqual([firstId!]); // no rebuild job
    expect(send).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe('delivered');
  });
});

describe('every end of a delivery is recorded, told and reported exactly once', () => {
  const refused = (code: number) =>
    new TelegramError({ ok: false, error_code: code, description: 'Bad Request' }, 'sendPhoto', {} as never);

  function enqueueWith(overrides: Partial<ImageDeliveryRequest>) {
    const process1 = startProcess();
    const requestNotes: string[] = [];
    process1.delivery.enqueue(request({ notify: async (text) => void requestNotes.push(text), ...overrides }));
    return { process1, requestNotes };
  }

  test('a render cut by the bound: recorded expired, one note, one timeout alert', async () => {
    const { process1, requestNotes } = enqueueWith({});
    [...queue.jobs.values()][0]!.result.reject(new RenderTimeoutError(150_000, 150_000));
    await process1.delivery.whenIdle();

    expect(onlyRow()).toMatchObject({ state: 'expired', note_sent: 1, job_json: null });
    expect(requestNotes).toEqual([tr.imageNoteTimedOut('2026-11-02')]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Timeout (render)');

    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.notes).toHaveLength(0); // the user was told once, not again after a restart
  });

  test('a render that failed: recorded failed, one note, one failure alert of its own kind', async () => {
    const { process1, requestNotes } = enqueueWith({});
    [...queue.jobs.values()][0]!.result.reject(new Error('worker crashed'));
    await process1.delivery.whenIdle();

    expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
    expect(requestNotes).toEqual([tr.imageNoteFailed('2026-11-02')]);
    expect(failures).toEqual([expect.objectContaining({ kind: 'day', errorName: 'Error' })]);
    expect(alerts).toEqual([]);
  });

  test('Telegram refusing the upload (a 4xx) is a failure the user is told about: the picture did not land', async () => {
    const { process1, requestNotes } = enqueueWith({
      send: async () => {
        throw refused(400);
      },
    });
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process1.delivery.whenIdle();

    expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
    expect(requestNotes).toEqual([tr.imageNoteFailed('2026-11-02')]);
    expect(failures).toHaveLength(1);
  });

  for (const [name, error] of [
    ['a dropped connection', new Error('socket hang up')],
    ['a Telegram server error (5xx)', refused(502)],
  ] as const) {
    test(`${name} during the upload is an uncertain send: recorded unknown, one note that it may not have arrived, never re-sent`, async () => {
      const { process1, requestNotes } = enqueueWith({
        send: async () => {
          throw error;
        },
      });
      [...queue.jobs.values()][0]!.result.resolve(png());
      await process1.delivery.whenIdle();

      expect(onlyRow()).toMatchObject({ state: 'unknown', note_sent: 0, job_json: null });
      // Not "it failed" (the picture may be in the chat), but not silence either: the answer may have been only this picture.
      expect(requestNotes).toEqual([tr.imageNoteUncertain('2026-11-02')]);
      expect(failures).toEqual([expect.objectContaining({ kind: 'day', errorName: 'UncertainSend' })]);
      expect(outcomes).toContainEqual(expect.objectContaining({ outcome: 'unknown', delivery: 'unknown' }));

      const process2 = startProcess();
      await process2.delivery.reconcile();
      expect(process2.sentImages).toHaveLength(0);
      expect(process2.notes).toHaveLength(0);
    });
  }

  for (const [name, error] of [
    ['a blocked bot (403)', refused(403)],
    ['a chat that is gone (404)', refused(404)],
    [
      'a chat Telegram reports as not found (400)',
      new TelegramError(
        { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
        'sendPhoto',
        {} as never,
      ),
    ],
    [
      'a group that does not let the bot send photos',
      new TelegramError(
        { ok: false, error_code: 400, description: 'Bad Request: not enough rights to send photos to the chat' },
        'sendPhoto',
        {} as never,
      ),
    ],
  ] as const) {
    test(`${name} is a failure asking again cannot fix: the user is told so without an offer to ask again, no alert is raised`, async () => {
      const { process1, requestNotes } = enqueueWith({
        send: async () => {
          throw error;
        },
      });
      [...queue.jobs.values()][0]!.result.resolve(png());
      await process1.delivery.whenIdle();

      expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
      expect(requestNotes).toEqual([tr.imageNoteRefused('2026-11-02')]);
      expect(requestNotes[0]).not.toContain('ещё раз');
      expect(failures).toEqual([]);
      expect(alerts).toEqual([]);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  }

  test('an upload that hangs past its bound: recorded unknown, one note that it may not have arrived, one timeout alert', async () => {
    const delivery = track(
      new ImageDelivery({
        renderer: queue,
        store,
        reportFailure: (report) => failures.push(report),
        sendBoundMs: 5,
      }),
    );
    const requestNotes: string[] = [];
    delivery.enqueue(
      request({ send: () => new Promise<number>(() => {}), notify: async (text) => void requestNotes.push(text) }),
    );
    [...queue.jobs.values()][0]!.result.resolve(png());
    await delivery.whenIdle();

    expect(onlyRow()).toMatchObject({ state: 'unknown', note_sent: 0 });
    expect(requestNotes).toEqual([tr.imageNoteUncertain('2026-11-02')]);
    expect(alerts).toHaveLength(1);
  });

  test('a delivery closed mid-render or mid-upload stays silent when its bounds pass later', async () => {
    // Bounds far above any scheduling stall: a GC pause or a loaded host between `enqueue` and `close` must not expire them.
    const limits = { store, reportFailure: (report: RenderFailureReport) => failures.push(report), sendBoundMs: 200 };
    const rendering = track(new ImageDelivery({ renderer: dying(queue), boundMs: 200, ...limits }));
    rendering.enqueue(request({ requestId: 1 })); // never finishes: its render bound would expire it
    const uploading = track(new ImageDelivery({ renderer: queue, ...limits }));
    uploading.enqueue(
      request({ requestId: 2, slot: 'day:user:1:2026-11-03', send: () => Promise.withResolvers<number>().promise }),
    );
    [...queue.jobs.values()].at(-1)!.result.resolve(png());
    await flush();

    await Promise.all([rendering.close(0), uploading.close(0)]);
    const loggedAtClose = outcomes.length;
    const reportedAtClose = failures.length;
    // Each run still waits for its own 200 ms bound; whenIdle resolves exactly when those timers have fired.
    await Promise.all([rendering.whenIdle(), uploading.whenIdle()]);

    expect(outcomes).toHaveLength(loggedAtClose);
    expect(failures).toHaveLength(reportedAtClose);
    expect(alerts).toEqual([]);
  });
});

describe('a delivery resumed after a restart keeps its slot', () => {
  const dayJob = (date: string) => () =>
    ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;

  test('the same picture asked again is the same delivery: one render, one picture', async () => {
    startProcess(undefined, true).delivery.enqueue(request({ requestId: 900 })); // the bot dies right after queueing
    const process2 = startProcess();
    await process2.delivery.reconcile();

    expect(process2.delivery.enqueue(request({ requestId: 901 }))).toEqual({ status: 'duplicate' });
    expect(queue.jobs.size).toBe(1);
    [...queue.jobs.values()][0]!.result.resolve(png());
    await process2.delivery.whenIdle();

    expect(process2.sentImages).toHaveLength(1);
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM image_deliveries').get()?.n).toBe(1);
  });

  test('the same slot with newer data supersedes the resumed picture: only the newest arrives', async () => {
    startProcess(undefined, true).delivery.enqueue(request({ requestId: 900, buildJob: dayJob('2026-11-02') }));
    const process2 = startProcess();
    await process2.delivery.reconcile();

    const newest = mock(async () => 11);
    expect(
      process2.delivery.enqueue(request({ requestId: 901, buildJob: dayJob('2026-11-03'), send: newest })),
    ).toEqual({
      status: 'queued',
    });
    await flush(); // the resumed wait ends on its abort and records `superseded`
    for (const job of queue.jobs.values()) job.result.resolve(png());
    await process2.delivery.whenIdle();

    expect(process2.sentImages).toHaveLength(0);
    expect(newest).toHaveBeenCalledTimes(1);
    expect(db.query<{ state: string }, []>('SELECT state FROM image_deliveries ORDER BY state').all()).toEqual([
      { state: 'delivered' },
      { state: 'superseded' },
    ]);
  });
});

describe('what a picture shows follows its rebuild', () => {
  const dayJob = (date: string) => () =>
    ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;

  test('after a rebuild the same request again is this picture, not a newer one that replaces it', async () => {
    const process1 = startProcess();
    let date = '2026-11-02';
    process1.delivery.enqueue(request({ buildJob: () => dayJob(date)() }));
    const [firstId] = [...queue.jobs.keys()];
    date = '2026-11-03'; // the write moved the event; the rebuild now shows the new date
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png());
    await flush();
    expect([...queue.jobs.keys()]).toEqual([firstId!, `${firstId}-r1`]);

    const again = process1.delivery.enqueue(request({ requestId: 901, buildJob: () => dayJob(date)() }));
    queue.jobs.get(`${firstId}-r1`)!.result.resolve(png());
    await process1.delivery.whenIdle();

    expect(again).toEqual({ status: 'duplicate' }); // not a second render that cancels the rebuild
    expect([...queue.jobs.keys()]).toHaveLength(2);
    expect(onlyRow().state).toBe('delivered');
  });

  test('a write that changes nothing the picture shows does not render it a second time', async () => {
    const process1 = startProcess();
    const send = mock(async () => 12);
    process1.delivery.enqueue(request({ send }));
    const [firstId] = [...queue.jobs.keys()];
    process1.delivery.eventsChanged(1); // another event, not on this day
    queue.jobs.get(firstId!)!.result.resolve(png());
    await process1.delivery.whenIdle();

    expect([...queue.jobs.keys()]).toEqual([firstId!]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onlyRow().state).toBe('delivered');
  });
});

describe('a restart while a picture is being rebuilt', () => {
  const dayJob = (date: string) => () =>
    ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;

  test('resumes the rebuilt job, so the picture the user gets shows the data the text already states', async () => {
    const process1 = startProcess();
    let date = '2026-11-02';
    process1.delivery.enqueue(request({ buildJob: () => dayJob(date)() }));
    const [firstId] = [...queue.jobs.keys()];
    date = '2026-11-03'; // the user moved the event while the first render ran
    process1.delivery.eventsChanged(1);
    queue.jobs.get(firstId!)!.result.resolve(png()); // the stale picture finished: the rebuild starts
    await flush();
    const rebuiltId = `${firstId}-r1`;
    expect(queue.jobs.has(rebuiltId)).toBe(true);
    await process1.delivery.close(); // a deploy: the rebuild is still rendering
    await process1.delivery.whenIdle();
    expect(onlyRow()).toMatchObject({ state: 'queued', rebuilds: 1 });
    expect(onlyRow().job_json).toContain('2026-11-03');

    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(queue.jobs.get(firstId!)!.adds).toBe(1); // the stale job is not waited for again
    expect(queue.jobs.get(rebuiltId)!.adds).toBe(2);
    queue.jobs.get(rebuiltId)!.result.resolve(png());
    await process2.delivery.whenIdle();
    expect(process2.sentImages).toHaveLength(1);
    expect(onlyRow().state).toBe('delivered');
  });
});

describe('a delivery left behind by a long downtime', () => {
  const later = (ms: number) => () => Date.now() + ms;

  test('past its bound by more than ten minutes it ends expired with no note and no timeout alert', async () => {
    startProcess(undefined, true).delivery.enqueue(request()); // the bot dies right after queueing
    const process2 = startProcess(later(3 * 86_400_000)); // it is back three days later
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();

    expect(process2.notes).toEqual([]);
    expect(alerts).toEqual([]);
    expect(onlyRow()).toMatchObject({ state: 'expired', note_sent: 1, job_json: null });
    expect(outcomes).toContainEqual(
      expect.objectContaining({ outcome: 'interrupted', phase: 'recovery', stale: true }),
    );
  });

  test('a failure the previous process never told about is not told days later either', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    db.run("UPDATE image_deliveries SET state = 'failed', job_json = NULL, note_sent = 0");
    const process2 = startProcess(later(3 * 86_400_000));
    await process2.delivery.reconcile();

    expect(process2.notes).toEqual([]);
    expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
  });

  test('a restart within minutes still tells the user once', async () => {
    startProcess(undefined, true).delivery.enqueue(request());
    const process2 = startProcess(later(5 * 60_000));
    await process2.delivery.reconcile();

    expect(process2.notes).toEqual([{ chatId: 7, text: tr.imageNoteInterrupted('2026-11-02') }]);
    expect(alerts).toEqual([]);
  });

  test('an upload cut off days ago ends unknown without an UncertainSend alert', async () => {
    const process1 = startProcess();
    process1.delivery.enqueue(request({ send: () => new Promise<number>(() => {}) })); // killed mid-upload
    [...queue.jobs.values()][0]!.result.resolve(png());
    await flush();
    expect(onlyRow().state).toBe('sending');

    const process2 = startProcess(later(3 * 86_400_000));
    await process2.delivery.reconcile();
    expect(onlyRow().state).toBe('unknown');
    expect(failures).toEqual([]);
    expect(process2.notes).toEqual([]);
    expect(outcomes).toContainEqual(expect.objectContaining({ outcome: 'unknown', recovered: true, stale: true }));
  });
});

describe('an outcome that could not be recorded', () => {
  /** A scheduler the test drives by hand: the retries of the refused write wait here until the test runs them. */
  function manualRetries() {
    const queued: (() => void)[] = [];
    return {
      schedule: (fn: () => void) => void queued.push(fn),
      runAll() {
        while (queued.length > 0) queued.shift()?.();
      },
    };
  }

  test('the user is still told once: the note cannot be claimed on a row that never reached its end state', async () => {
    const retries = manualRetries();
    const process1 = startProcess(undefined, false, { schedule: retries.schedule });
    const requestNotes: string[] = [];
    process1.delivery.enqueue(request({ notify: async (text) => void requestNotes.push(text) }));
    store.finish = () => {
      throw new Error('database is locked');
    };
    [...queue.jobs.values()][0]!.result.reject(new Error('worker crashed'));
    await process1.delivery.whenIdle();
    retries.runAll(); // every retry is refused as well

    expect(requestNotes).toEqual([tr.imageNoteFailed('2026-11-02')]);
    expect(failures).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.anything(), 'Image delivery: the outcome was never recorded');
  });

  test('the write is tried again: a restart then finds the row ended and told, and says nothing more', async () => {
    const retries = manualRetries();
    const process1 = startProcess(undefined, false, { schedule: retries.schedule });
    const requestNotes: string[] = [];
    process1.delivery.enqueue(request({ notify: async (text) => void requestNotes.push(text) }));
    const realFinish = store.finish.bind(store);
    let refusals = 1;
    store.finish = (...args: Parameters<typeof realFinish>) => {
      if (refusals-- > 0) throw new Error('database is locked');
      return realFinish(...args);
    };
    [...queue.jobs.values()][0]!.result.reject(new Error('worker crashed'));
    await process1.delivery.whenIdle();
    expect(onlyRow().state).toBe('queued'); // the end was refused once: the row has not caught up yet
    retries.runAll();

    expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
    expect(requestNotes).toEqual([tr.imageNoteFailed('2026-11-02')]);

    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();
    expect(process2.notes).toEqual([]);
    expect(process2.sentImages).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  test('a graceful shutdown tries the refused write once more: a superseded older picture is not resumed by the next start', async () => {
    const dayJob = (date: string) => () =>
      ({ type: 'daily-agenda', data: { date, theme: {}, locale: 'ru' }, userId: 1 }) as ImageRenderJob;
    const retries = manualRetries(); // its timers never fire: the process is going down first
    const process1 = startProcess(undefined, false, { schedule: retries.schedule });
    const realFinish = store.finish.bind(store);
    let locked = true;
    store.finish = (...args: Parameters<typeof realFinish>) => {
      if (locked) throw new Error('database is locked');
      return realFinish(...args);
    };
    process1.delivery.enqueue(request({ requestId: 1, buildJob: dayJob('2026-11-02') }));
    process1.delivery.enqueue(request({ requestId: 2, buildJob: dayJob('2026-11-03') })); // supersedes the first; its end is refused
    expect(
      db
        .query<{ state: string }, []>('SELECT state FROM image_deliveries')
        .all()
        .map((r) => r.state),
    ).toEqual(['queued', 'queued']);

    locked = false; // the database is back by the time the bot shuts down
    await process1.delivery.close(0);
    await process1.delivery.whenIdle();

    expect(
      db
        .query<{ state: string }, []>('SELECT state FROM image_deliveries')
        .all()
        .map((r) => r.state)
        .sort(),
    ).toEqual(['queued', 'superseded']);
    for (const job of queue.jobs.values()) job.result.resolve(png());
    const process2 = startProcess();
    await process2.delivery.reconcile();
    await process2.delivery.whenIdle();
    expect(process2.sentImages).toHaveLength(1);
  });

  test('a refusal in the note claim is tried again as the claim alone: a restart does not tell the user a second time', async () => {
    const retries = manualRetries();
    const process1 = startProcess(undefined, false, { schedule: retries.schedule });
    const requestNotes: string[] = [];
    process1.delivery.enqueue(request({ notify: async (text) => void requestNotes.push(text) }));
    const realFinish = store.finish.bind(store);
    const realClaim = store.markNoteSent.bind(store);
    let finishRefusals = 1;
    let claimRefusals = 1;
    store.finish = (...args: Parameters<typeof realFinish>) => {
      if (finishRefusals-- > 0) throw new Error('database is locked');
      return realFinish(...args);
    };
    store.markNoteSent = (id: string) => {
      if (claimRefusals-- > 0) throw new Error('database is locked');
      return realClaim(id);
    };
    [...queue.jobs.values()][0]!.result.reject(new Error('worker crashed'));
    await process1.delivery.whenIdle();
    retries.runAll(); // the end is written, the claim is refused, then the claim alone goes through

    expect(onlyRow()).toMatchObject({ state: 'failed', note_sent: 1 });
    const process2 = startProcess();
    await process2.delivery.reconcile();
    expect(process2.notes).toEqual([]);
    expect(requestNotes).toEqual([tr.imageNoteFailed('2026-11-02')]);
  });

  test('the shutdown write stops at the first refusal: SQLite already waited its whole busy timeout on that thread', async () => {
    const retries = manualRetries();
    const process1 = startProcess(undefined, false, { schedule: retries.schedule });
    for (const [index, slot] of ['day:user:1:a', 'day:user:1:b'].entries()) {
      process1.delivery.enqueue(request({ requestId: index, slot }));
    }
    let writes = 0;
    store.finish = () => {
      writes++;
      throw new Error('database is locked');
    };
    for (const job of queue.jobs.values()) job.result.reject(new Error('worker crashed'));
    await process1.delivery.whenIdle();
    expect(writes).toBe(2); // each end was refused once while it happened

    await process1.delivery.close(0);
    expect(writes).toBe(3); // one shutdown attempt, not one per delivery
  });
});
