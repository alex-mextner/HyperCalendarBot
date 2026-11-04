// ChatRunGate: one run at a time per chat, in arrival order; other chats are not held back; a run that
// never finishes cannot freeze its chat. Time is a clock and a timer list the test moves, never real time.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ChatRunGate,
  type ChatRunSlot,
  type ChatTurn,
  type ChatTurnReservation,
} from '../../../src/services/ai/chat-run-gate.ts';
import { ManualTime } from '../../helpers/manual-time.ts';

const LEASE_MS = 120_000;

/** A run the test finishes by hand; `slot` is what the gate told it when it started. */
function manualRun(gate: ChatRunGate, chatId: number, name: string, log: string[], turn: ChatTurn = {}) {
  const finish = Promise.withResolvers<string>();
  const started = Promise.withResolvers<ChatRunSlot>();
  const result = gate.run(chatId, turn, async (slot) => {
    log.push(`start ${name}`);
    started.resolve(slot);
    const value = await finish.promise;
    log.push(`end ${name}`);
    return value;
  });
  return {
    result,
    started: started.promise,
    finish: (value = name) => finish.resolve(value),
    fail: (error: Error) => finish.reject(error),
  };
}

/** Lets every pending continuation run. */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

describe('ChatRunGate', () => {
  let time: ManualTime;
  let gate: ChatRunGate;
  let log: string[];

  beforeEach(() => {
    time = new ManualTime();
    gate = new ChatRunGate({ leaseMs: LEASE_MS, now: time.now, schedule: time.schedule });
    log = [];
  });

  test('runs of one chat start one after another, in arrival order', async () => {
    const first = manualRun(gate, 1, 'a', log);
    const second = manualRun(gate, 1, 'b', log);
    const third = manualRun(gate, 1, 'c', log);
    await settle();
    expect(log).toEqual(['start a']);

    third.finish();
    second.finish();
    await settle();
    expect(log).toEqual(['start a']); // b and c still wait for a

    first.finish();
    await settle();
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(await Promise.all([first.result, second.result, third.result])).toEqual(['a', 'b', 'c']);
  });

  test('another chat is not held back', async () => {
    const slow = manualRun(gate, 1, 'slow', log);
    const other = manualRun(gate, 2, 'other', log);
    await settle();
    expect(log).toEqual(['start slow', 'start other']);
    other.finish();
    await other.result;
    slow.finish();
    await slow.result;
  });

  test('an idle chat starts a run synchronously and reports that it did not wait', async () => {
    let startedSynchronously = false;
    const result = gate.run(1, {}, async (slot) => {
      startedSynchronously = true;
      expect(slot.waited).toBe(false);
      expect(slot.waitedMs).toBe(0);
      return 'ok';
    });
    expect(startedSynchronously).toBe(true);
    expect(await result).toBe('ok');
  });

  test('a run that waited knows it and for how long', async () => {
    const first = manualRun(gate, 1, 'a', log);
    const second = manualRun(gate, 1, 'b', log);
    await settle();
    time.advance(7_000);
    first.finish();
    const slot = await second.started;
    expect(slot.waited).toBe(true);
    expect(slot.waitedMs).toBe(7_000);
    second.finish();
    await second.result;
  });

  test('a failing run releases the chat to the next run and still rejects for its caller', async () => {
    const first = manualRun(gate, 1, 'a', log);
    const second = manualRun(gate, 1, 'b', log);
    await settle();
    first.fail(new Error('model down'));
    await expect(first.result).rejects.toThrow('model down');
    await settle();
    expect(log).toContain('start b');
    second.finish();
    expect(await second.result).toBe('b');
  });

  test('a task that throws before returning a promise is a rejection and frees the chat', async () => {
    const broken = gate.run(1, {}, () => {
      throw new Error('broken task');
    });
    await expect(broken).rejects.toThrow('broken task');
    expect(gate.busyChats).toBe(0);
  });

  test('a run that never finishes holds its chat only for the lease', async () => {
    const hung = manualRun(gate, 1, 'hung', log);
    const next = manualRun(gate, 1, 'next', log);
    const last = manualRun(gate, 1, 'last', log);
    await settle();
    time.advance(LEASE_MS - 1);
    await settle();
    expect(log).toEqual(['start hung']);

    time.advance(1);
    await settle();
    expect(log).toEqual(['start hung', 'start next']); // next stopped waiting; last still waits for next
    next.finish();
    await settle();
    expect(log).toContain('start last');

    // The hung run finishing late changes nothing for the others and still resolves for its caller.
    hung.finish();
    last.finish();
    expect(await Promise.all([hung.result, next.result, last.result])).toEqual(['hung', 'next', 'last']);
    expect(gate.busyChats).toBe(0);
  });

  test('the lease of a run behind a hung one counts from when it began, not when it was queued', async () => {
    const hung = manualRun(gate, 1, 'hung', log);
    const second = manualRun(gate, 1, 'second', log);
    const third = manualRun(gate, 1, 'third', log);
    await settle();
    time.advance(LEASE_MS);
    await settle();
    expect(log).toEqual(['start hung', 'start second']);
    time.advance(LEASE_MS - 1);
    await settle();
    expect(log).toEqual(['start hung', 'start second']); // third has waited long, but second began only a moment ago
    time.advance(1);
    await settle();
    expect(log).toEqual(['start hung', 'start second', 'start third']);
    for (const run of [hung, second, third]) run.finish();
    await Promise.all([hung.result, second.result, third.result]);
  });

  test('waiting ends at once on shutdown, and a run queued after shutdown does not wait at all', async () => {
    const shutdown = new AbortController();
    const running = manualRun(gate, 1, 'running', log);
    const queued = gate.run(1, { abort: shutdown.signal }, async () => {
      log.push('start queued');
      return 'queued';
    });
    await settle();
    expect(log).toEqual(['start running']);
    shutdown.abort(new Error('Bot is shutting down'));
    expect(await queued).toBe('queued');
    const late = gate.run(1, { abort: shutdown.signal }, async () => 'late');
    expect(await late).toBe('late');
    running.finish();
    await running.result;
    expect(gate.busyChats).toBe(0);
  });

  test('a finished chat leaves nothing behind: no queue entry, no running timer', async () => {
    const first = manualRun(gate, 1, 'a', log);
    const second = manualRun(gate, 1, 'b', log);
    await settle();
    expect(gate.busyChats).toBe(1);
    first.finish();
    second.finish();
    await Promise.all([first.result, second.result]);
    expect(gate.busyChats).toBe(0);
    expect(time.pendingTimers).toBe(0);
  });

  test('a run is told which reserved turns are queued behind it, never its own', async () => {
    const [r10, r11, r12] = [10, 11, 12].map((row) => gate.reserve(1, row)) as [
      ChatTurnReservation,
      ChatTurnReservation,
      ChatTurnReservation,
    ];
    const r99 = gate.reserve(2, 99);
    const first = manualRun(gate, 1, 'a', log, { reservation: r10 });
    const second = manualRun(gate, 1, 'b', log, { reservation: r11 });
    const third = manualRun(gate, 1, 'c', log, { reservation: r12 });
    const otherChat = manualRun(gate, 2, 'e', log, { reservation: r99 });
    const firstSlot = await first.started;
    expect(firstSlot.ownRowId).toBe(10);
    expect([...firstSlot.queuedTurnRowIds()].sort()).toEqual([11, 12]);
    first.finish();
    const secondSlot = await second.started;
    expect([...secondSlot.queuedTurnRowIds()]).toEqual([12]);
    for (const run of [second, third, otherChat]) run.finish();
    await Promise.all([first.result, second.result, third.result, otherChat.result]);
  });

  test('a run without a reservation joins the end, owns no row and hides no one else’s', async () => {
    const r10 = gate.reserve(1, 10);
    const scheduled = manualRun(gate, 1, 'scheduled', log); // borrows a row id for its action log; the gate never sees it
    await settle();
    expect(log).toEqual([]); // waits behind the place reserved for row 10
    const r11 = gate.reserve(1, 11);
    const own = manualRun(gate, 1, 'own', log, { reservation: r10 });
    const ownSlot = await own.started; // the place of row 10 was ahead of the scheduled run
    expect(ownSlot.ownRowId).toBe(10);
    expect([...ownSlot.queuedTurnRowIds()]).toEqual([11]);
    own.finish();
    await settle();
    expect(log).toEqual(['start own', 'end own', 'start scheduled']); // joined before row 11 was saved
    r11.release();
    const slot = await scheduled.started;
    expect(slot.ownRowId).toBeUndefined();
    scheduled.finish();
    await Promise.all([own.result, scheduled.result]);
  });

  test('a reservation made in another chat is not taken over', async () => {
    const elsewhere = gate.reserve(2, 5);
    const run = manualRun(gate, 1, 'a', log, { reservation: elsewhere });
    const slot = await run.started;
    expect(slot.ownRowId).toBeUndefined();
    run.finish();
    await run.result;
    elsewhere.release();
  });

  describe('reserved places', () => {
    test('a message whose handler reaches the gate late still runs in the order it was saved', async () => {
      const first = gate.reserve(1, 1);
      const second = gate.reserve(1, 2);
      // The second message's handler is quicker: it reaches the gate first.
      const later = manualRun(gate, 1, 'second', log, { reservation: second });
      await settle();
      expect(log).toEqual([]); // row 1 holds the first place
      const earlier = manualRun(gate, 1, 'first', log, { reservation: first });
      await settle();
      expect(log).toEqual(['start first']);
      earlier.finish();
      await settle();
      expect(log).toEqual(['start first', 'end first', 'start second']);
      later.finish();
      await Promise.all([earlier.result, later.result]);
    });

    test('the run for a row sees a message saved after it as queued behind it, handler order notwithstanding', async () => {
      const r1 = gate.reserve(1, 1);
      const r2 = gate.reserve(1, 2);
      const second = manualRun(gate, 1, 'second', log, { reservation: r2 });
      const first = manualRun(gate, 1, 'first', log, { reservation: r1 });
      const slot = await first.started;
      expect([...slot.queuedTurnRowIds()]).toEqual([2]);
      first.finish();
      second.finish();
      await Promise.all([first.result, second.result]);
    });

    test('a place released without a run (an intent answered, a command) lets the run behind it go', async () => {
      const intent = gate.reserve(1, 1);
      const r2 = gate.reserve(1, 2);
      const agent = manualRun(gate, 1, 'agent', log, { reservation: r2 });
      await settle();
      expect(log).toEqual([]);
      intent.release();
      await settle();
      expect(log).toEqual(['start agent']);
      agent.finish();
      await agent.result;
    });

    test('a place nobody uses is given up after the reservation time', async () => {
      gate.reserve(1, 1);
      const behind = manualRun(gate, 1, 'behind', log);
      await settle();
      expect(log).toEqual([]);
      time.advance(60_000);
      await settle();
      expect(log).toEqual(['start behind']);
      behind.finish();
      await behind.result;
      expect(gate.busyChats).toBe(0);
      expect(time.pendingTimers).toBe(0);
    });

    test('releasing after the run took the place over changes nothing', async () => {
      const reservation = gate.reserve(1, 1);
      const run = manualRun(gate, 1, 'a', log, { reservation });
      const behind = manualRun(gate, 1, 'b', log);
      await settle();
      reservation.release();
      await settle();
      expect(log).toEqual(['start a']);
      run.finish();
      behind.finish();
      await Promise.all([run.result, behind.result]);
    });

    test('a second run of the same update does not take the place twice', async () => {
      const reservation = gate.reserve(1, 1);
      const main = manualRun(gate, 1, 'main', log, { reservation });
      const again = manualRun(gate, 1, 'again', log, { reservation });
      await settle();
      expect(log).toEqual(['start main']); // the second joins the end, behind the first
      main.finish();
      const slot = await again.started;
      expect(slot.ownRowId).toBeUndefined();
      again.finish();
      await Promise.all([main.result, again.result]);
    });

    test('a run whose place expired still owns its message and is placed behind the runs in between', async () => {
      const time = new ManualTime();
      const expiring = new ChatRunGate({
        leaseMs: LEASE_MS,
        reservationMs: 1000,
        now: time.now,
        schedule: time.schedule,
      });
      const reservation = expiring.reserve(1, 10);
      time.advance(1000);
      const slot = await expiring.run(1, { reservation }, async (s) => s);
      expect(slot.ownRowId).toBe(10);
      const second = await expiring.run(1, { reservation }, async (s) => s);
      expect(second.ownRowId).toBeUndefined();
    });

    test('a released place does not let a run behind it overtake a run still working ahead of it', async () => {
      const working = manualRun(gate, 1, 'working', log);
      const intent = gate.reserve(1, 5);
      const behind = manualRun(gate, 1, 'behind', log);
      await settle();
      intent.release();
      await settle();
      expect(log).toEqual(['start working']);
      working.finish();
      await settle();
      expect(log).toEqual(['start working', 'end working', 'start behind']);
      behind.finish();
      await Promise.all([working.result, behind.result]);
    });

    test('a throwing waiting signal does not stop the run', async () => {
      const working = manualRun(gate, 1, 'working', log);
      const waiting = gate.run(
        1,
        {
          whileWaiting: () => {
            throw new Error('synthetic typing failure');
          },
        },
        async () => 'ran',
      );
      working.finish();
      expect(await waiting).toBe('ran');
      await working.result;
      expect(gate.busyChats).toBe(0);
    });
  });
});

describe('ChatRunGate waiting signals', () => {
  const LEASE = 60_000;

  function fixture() {
    const time = new ManualTime();
    return { time, gate: new ChatRunGate({ leaseMs: LEASE, now: time.now, schedule: time.schedule }) };
  }

  test('whileWaiting starts only for a run that has to wait and stops when its wait ends', async () => {
    const { gate } = fixture();
    const events: string[] = [];
    const hold = Promise.withResolvers<void>();
    const first = gate.run(1, { whileWaiting: () => () => events.push('first-stop') }, () => hold.promise);
    const second = gate.run(
      1,
      {
        whileWaiting: () => {
          events.push('second-wait');
          return () => events.push('second-stop');
        },
      },
      async () => {
        events.push('second-run');
      },
    );
    expect(gate.isBusy(1)).toBe(true);
    expect(gate.isBusy(2)).toBe(false);
    expect(events).toEqual(['second-wait']);
    hold.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['second-wait', 'second-stop', 'second-run']);
    expect(gate.isBusy(1)).toBe(false);
  });

  test('the wait hook is stopped when the wait ends by shutdown too', async () => {
    const { gate } = fixture();
    const shutdown = new AbortController();
    const hold = Promise.withResolvers<void>();
    const stops: string[] = [];
    void gate.run(1, {}, () => hold.promise);
    const queued = gate.run(
      1,
      { abort: shutdown.signal, whileWaiting: () => () => stops.push('stopped') },
      async () => 'ran',
    );
    shutdown.abort(new Error('Bot is shutting down'));
    expect(await queued).toBe('ran');
    expect(stops).toEqual(['stopped']);
    hold.resolve();
  });

  test('leaseExpired is true only when the run ahead was still holding the chat at the lease', async () => {
    const { time, gate } = fixture();
    const hold = Promise.withResolvers<void>();
    void gate.run(1, {}, () => hold.promise);
    const slots: boolean[] = [];
    const late = gate.run(1, {}, async (slot) => {
      slots.push(slot.leaseExpired);
    });
    time.advance(LEASE);
    await late;

    const quick = Promise.withResolvers<void>();
    const done = gate.run(2, {}, () => quick.promise);
    const after = gate.run(2, {}, async (slot) => {
      slots.push(slot.leaseExpired);
    });
    quick.resolve();
    await Promise.all([done, after]);
    const idle = await gate.run(3, {}, async (slot) => slot.leaseExpired);
    expect([...slots, idle]).toEqual([true, false, false]);
    hold.resolve();
  });

  test('a run that starts beside a hung run of the chat knows it, however many runs sit between', async () => {
    const { time, gate } = fixture();
    const hung = Promise.withResolvers<void>();
    void gate.run(1, {}, () => hung.promise);
    const bFinish = Promise.withResolvers<void>();
    const flags: Record<string, boolean> = {};
    const b = gate.run(1, {}, async (slot) => {
      flags.b = slot.leaseExpired;
      await bFinish.promise;
    });
    const c = gate.run(1, {}, async (slot) => {
      flags.c = slot.leaseExpired;
    });
    time.advance(LEASE);
    await settle();
    bFinish.resolve();
    await Promise.all([b, c]);
    expect(flags).toEqual({ b: true, c: true });
    hung.resolve();
  });

  test('a hung run is announced once, not on every later message', async () => {
    const { time, gate } = fixture();
    const hung = Promise.withResolvers<void>();
    void gate.run(1, {}, () => hung.promise);
    const first = gate.run(1, { reservation: gate.reserve(1, 1) }, async (slot) => slot.leaseExpired);
    time.advance(LEASE);
    expect(await first).toBe(true);
    const second = await gate.run(1, { reservation: gate.reserve(1, 2) }, async (slot) => slot.leaseExpired);
    expect(second).toBe(false);
    hung.resolve();
  });

  test('a run without a message of its own does not use up the notice of a hung run', async () => {
    const { time, gate } = fixture();
    const hung = Promise.withResolvers<void>();
    void gate.run(1, {}, () => hung.promise);
    const scheduled = gate.run(1, {}, async (slot) => slot.leaseExpired);
    const reservation = gate.reserve(1, 7);
    const user = gate.run(1, { reservation }, async (slot) => slot.leaseExpired);
    time.advance(LEASE);
    expect(await scheduled).toBe(true);
    expect(await user).toBe(true);
    hung.resolve();
  });

  test('shutdown while runs queue behind a hung one leaves no lease timer running', async () => {
    const { time, gate } = fixture();
    const shutdown = new AbortController();
    const hung = Promise.withResolvers<void>();
    void gate.run(1, {}, () => hung.promise);
    const bFinish = Promise.withResolvers<void>();
    const b = gate.run(1, { abort: shutdown.signal }, () => bFinish.promise);
    const c = gate.run(1, { abort: shutdown.signal }, async () => {});
    shutdown.abort(new Error('Bot is shutting down'));
    await settle();
    expect(time.pendingTimers).toBe(0);
    bFinish.resolve();
    hung.resolve();
    await Promise.all([b, c]);
  });
});
