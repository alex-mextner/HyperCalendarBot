// src/services/ai/chat-run-gate.ts
//
// One agent run at a time per chat, in arrival order; different chats stay parallel.
//
// GramIO hands every Telegram update to its handler without waiting for the previous one (webhook
// and long polling alike), so two messages of one chat used to run two agents on overlapping
// history. On 2026-11-01 two quick confirmations did exactly that and every event was created
// twice. A run now starts only after the runs ahead of it in the same chat have finished and
// written their turn, so it reads the history they produced.
//
// Arrival order is the order the messages were SAVED in, not the order their handlers reach the agent
// (a handler may wait on a scene or retry lookup first). So the place in line is reserved at the moment
// the message is saved (`reserve`), and the run that answers that message takes the place over (`run`
// with that reservation; see chat-turn-context.ts for how a run finds it). A reservation the handler never turns into a run (an intent answered it, a
// command, a failed update) is released when the update ends or after `reservationMs`.
//
// A run that never finishes must not freeze its chat: the run behind stops waiting once the run
// ahead has held the chat for `leaseMs` (the request budget plus a grace), says so in the log and
// goes on. Shutdown also ends the wait, so queued runs take their normal fail-fast path.

import { logger } from '../../utils/logger.ts';
import { reportTimeout } from '../incident/timeout-reporter.ts';

const gateLogger = logger.child({ module: 'ai-chat-gate' });

/** What a run learns when its turn in the chat comes. */
export interface ChatRunSlot {
  /** True when the run had to wait behind an earlier run of the same chat. */
  readonly waited: boolean;
  /**
   * True when the run starts beside an earlier run of the chat that is still unfinished because it held the
   * chat past its lease and no earlier run has reported that yet (a hung run is announced once). Never true
   * when the wait ended at shutdown.
   */
  readonly leaseExpired: boolean;
  readonly waitedMs: number;
  /**
   * The chat_history row of the message this run answers, when the run took over the place reserved for
   * that message; undefined for a run that has no message of its own (scheduled, synthetic).
   */
  readonly ownRowId: number | undefined;
  /**
   * chat_history rows of the turns queued behind this run right now (reserved or waiting). They arrived
   * after this run's message, so its model must not read them as already said.
   */
  queuedTurnRowIds(): ReadonlySet<number>;
}

export interface ChatRunGateOptions {
  /** How long a run holds its chat before the run behind it stops waiting for it. */
  leaseMs: number;
  /** How long a reserved place may stay unclaimed before it is given up. Default 60 s. */
  reservationMs?: number;
  now?: () => number;
  /** Starts a timer and returns its cancel function; replaceable so tests need no real time. */
  schedule?: (callback: () => void, ms: number) => () => void;
}

export interface ChatTurn {
  /**
   * The place reserved for the message this run answers, when there is one: it is taken over. Without it the
   * run joins the end of the line and has no message of its own (scheduled, synthetic).
   */
  reservation?: ChatTurnReservation;
  /** Aborts the wait: used at shutdown, when every queued run should fail fast rather than queue. */
  abort?: AbortSignal;
  /** Called when this run has to wait; the function it returns is called when the wait ends (typing, say). */
  whileWaiting?: () => () => void;
}

/** A reserved place in a chat's line. `release` gives it up; harmless after the run took it over. */
export interface ChatTurnReservation {
  readonly chatId: number;
  /** The chat_history row of the message the place is held for. */
  readonly rowId: number;
  release(): void;
}

interface QueuedRun {
  /** The message this entry stands for; undefined for a run without a message of its own. */
  rowId: number | undefined;
  /** True from `reserve` until a run takes the place over. */
  reserved: boolean;
  cancelExpiry: (() => void) | undefined;
  started: PromiseWithResolvers<void>;
  /** Set before `started` settles. */
  startedAt: number;
  finished: PromiseWithResolvers<void>;
  settled: boolean;
  /** True once a later run has reported giving up on this entry: a hung run is announced once, not per message. */
  leaseAnnounced: boolean;
  /** True once the lease that ran out on this entry was counted as a timeout, so one hung run counts once. */
  leaseReported: boolean;
}

function newEntry(rowId: number | undefined, reserved: boolean): QueuedRun {
  return {
    rowId,
    reserved,
    cancelExpiry: undefined,
    started: Promise.withResolvers<void>(),
    startedAt: 0,
    finished: Promise.withResolvers<void>(),
    settled: false,
    leaseAnnounced: false,
    leaseReported: false,
  };
}

function scheduleWithTimeout(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

const DEFAULT_RESERVATION_MS = 60_000;

export class ChatRunGate {
  private readonly leaseMs: number;
  private readonly reservationMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, ms: number) => () => void;
  /** Per chat: the places not yet finished, oldest first. A chat with none has no entry. */
  private readonly lines = new Map<number, QueuedRun[]>();
  private readonly reservedEntries = new WeakMap<ChatTurnReservation, QueuedRun>();
  /** Reservations a run has claimed the message of, so a second run of the same update gets no row of its own. */
  private readonly claimedReservations = new WeakSet<ChatTurnReservation>();

  constructor(options: ChatRunGateOptions) {
    this.leaseMs = options.leaseMs;
    this.reservationMs = options.reservationMs ?? DEFAULT_RESERVATION_MS;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleWithTimeout;
  }

  /** Chats that have a run in flight or queued; zero once everything has finished. */
  get busyChats(): number {
    return this.lines.size;
  }

  /** True while a run of the chat is in flight or queued: a run arriving now would have to wait. */
  isBusy(chatId: number): boolean {
    return this.lines.has(chatId);
  }

  /**
   * Holds the next place in the chat's line for the message saved as `rowId`, synchronously, before the
   * message's handler can wait on anything. Runs behind this place wait for it; the run for the same
   * row takes it over.
   */
  reserve(chatId: number, rowId: number): ChatTurnReservation {
    const line = this.lines.get(chatId) ?? [];
    this.lines.set(chatId, line);
    const entry = newEntry(rowId, true);
    line.push(entry);
    entry.cancelExpiry = this.schedule(() => {
      if (!entry.reserved) return;
      gateLogger.warn(
        { chatId, rowId, reservationMs: this.reservationMs },
        'A reserved place in the chat was never used',
      );
      // The message's handler ran longer than its reservation: it loses its place in the line, so a message
      // saved after it can run first. It still runs, at the end of the line: recovered.
      reportTimeout({
        kind: 'chat_run_reservation',
        elapsedMs: this.reservationMs,
        limitMs: this.reservationMs,
        recovered: true,
      });
      this.release(chatId, entry);
    }, this.reservationMs);
    const reservation: ChatTurnReservation = {
      chatId,
      rowId,
      release: () => {
        if (entry.reserved) this.release(chatId, entry);
      },
    };
    this.reservedEntries.set(reservation, entry);
    return reservation;
  }

  /**
   * Runs `task` once every earlier run of `chatId` has finished (or held the chat past its lease).
   * With nothing ahead the task starts synchronously, so an idle chat sees no change at all.
   */
  run<T>(chatId: number, turn: ChatTurn, task: (slot: ChatRunSlot) => Promise<T>): Promise<T> {
    const line = this.lines.get(chatId) ?? [];
    this.lines.set(chatId, line);
    const held =
      turn.reservation && turn.reservation.chatId === chatId ? this.reservedEntries.get(turn.reservation) : undefined;
    const reserved = held?.reserved ? held : undefined;
    const entry = reserved ?? newEntry(undefined, false);
    if (reserved) {
      reserved.reserved = false;
      reserved.cancelExpiry?.();
    } else line.push(entry);
    // The message stays the run's own even when its place expired before the run got here: its row must
    // still be placed after what the runs in between wrote.
    const own =
      turn.reservation && turn.reservation.chatId === chatId && !this.claimedReservations.has(turn.reservation)
        ? turn.reservation
        : undefined;
    if (own) this.claimedReservations.add(own);
    const ownRowId = own?.rowId;
    const hasAhead = line.indexOf(entry) > 0;
    const enqueuedAt = this.now();

    const start = (leaseExpired: boolean): Promise<T> => {
      entry.startedAt = this.now();
      entry.started.resolve();
      const slot: ChatRunSlot = {
        waited: hasAhead,
        leaseExpired,
        waitedMs: entry.startedAt - enqueuedAt,
        ownRowId,
        queuedTurnRowIds: () => this.rowsQueuedBehind(chatId, entry),
      };
      if (slot.waited) {
        gateLogger.info(
          { chatId, waitedMs: slot.waitedMs, queuedBehind: this.queuedBehind(chatId, entry).length },
          'Agent run started after waiting for the previous run in this chat',
        );
      }
      let running: Promise<T>;
      try {
        running = task(slot);
      } catch (err) {
        running = Promise.reject(err);
      }
      return running.finally(() => this.release(chatId, entry));
    };

    // With nothing ahead the task starts on the caller's stack, as an ungated run always did.
    if (!hasAhead) return start(false);
    let stopWaitingSignal: (() => void) | undefined;
    try {
      stopWaitingSignal = turn.whileWaiting?.();
    } catch (err) {
      // A typing indicator is a courtesy: it must not stop the run or leave its place in line unused.
      gateLogger.warn({ err, chatId }, 'Could not show that a message is waiting for its turn');
    }
    return this.untilTurn(chatId, entry, turn.abort, ownRowId !== undefined)
      .finally(() => stopWaitingSignal?.())
      .then(start);
  }

  private queuedBehind(chatId: number, entry: QueuedRun): QueuedRun[] {
    const line = this.lines.get(chatId) ?? [];
    const index = line.indexOf(entry);
    return index === -1 ? [] : line.slice(index + 1);
  }

  private rowsQueuedBehind(chatId: number, entry: QueuedRun): ReadonlySet<number> {
    const rows = new Set<number>();
    for (const queued of this.queuedBehind(chatId, entry)) {
      if (queued.rowId !== undefined && queued.rowId !== entry.rowId) rows.add(queued.rowId);
    }
    return rows;
  }

  private release(chatId: number, entry: QueuedRun): void {
    entry.settled = true;
    entry.reserved = false;
    entry.cancelExpiry?.();
    entry.finished.resolve();
    const line = this.lines.get(chatId);
    if (!line) return;
    const index = line.indexOf(entry);
    if (index !== -1) line.splice(index, 1);
    if (line.length === 0) this.lines.delete(chatId);
  }

  /** The unfinished place nearest ahead of `entry` that has not already been given up on. */
  private nearestAhead(chatId: number, entry: QueuedRun, givenUp: ReadonlySet<QueuedRun>): QueuedRun | undefined {
    const line = this.lines.get(chatId) ?? [];
    for (let index = line.indexOf(entry) - 1; index >= 0; index--) {
      const candidate = line[index]!;
      if (!candidate.settled && !givenUp.has(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * Resolves when every place ahead of `entry` has finished, has held the chat for the lease, or shutdown
   * began; true when the run starts beside an unfinished earlier run (the lease), false otherwise. A place
   * ahead may itself still be queued or reserved, so its lease starts counting once it began.
   */
  private async untilTurn(
    chatId: number,
    entry: QueuedRun,
    abort: AbortSignal | undefined,
    announces: boolean,
  ): Promise<boolean> {
    const givenUp = new Set<QueuedRun>();
    for (;;) {
      if (abort?.aborted) return false;
      const ahead = this.nearestAhead(chatId, entry, givenUp);
      if (!ahead) {
        const fresh = [...givenUp].filter((given) => !given.settled && !given.leaseAnnounced);
        // A run with no message of its own cannot show the notice, so it must not use it up for the next.
        if (announces) for (const given of fresh) given.leaseAnnounced = true;
        return fresh.length > 0;
      }
      if (await this.waitFor(chatId, ahead, abort)) givenUp.add(ahead);
      else if (abort?.aborted) return false;
    }
  }

  /** Waits for one place: false when it finished or shutdown began, true when its lease ran out first. */
  private async waitFor(chatId: number, ahead: QueuedRun, abort: AbortSignal | undefined): Promise<boolean> {
    const done = Promise.withResolvers<void>();
    let cancelLease: (() => void) | undefined;
    let over = false;
    const onAbort = () => done.resolve();
    if (abort?.aborted) done.resolve();
    else abort?.addEventListener('abort', onAbort, { once: true });
    void ahead.finished.promise.then(() => done.resolve());
    void ahead.started.promise.then(() => {
      if (over) return;
      const remaining = ahead.startedAt + this.leaseMs - this.now();
      if (remaining <= 0) done.resolve();
      else cancelLease = this.schedule(() => done.resolve(), remaining);
    });
    await done.promise;
    over = true;
    cancelLease?.();
    abort?.removeEventListener('abort', onAbort);
    const leaseRanOut = !ahead.settled && abort?.aborted !== true;
    if (!ahead.settled) {
      const heldMs = ahead.startedAt === 0 ? 0 : this.now() - ahead.startedAt;
      gateLogger.warn(
        { chatId, heldMs, leaseMs: this.leaseMs, shuttingDown: abort?.aborted === true },
        'Not waiting any longer for the earlier agent run in this chat',
      );
      // The waiting message goes on beside the hung run, so it is served: recovered. The hung run's own
      // deadline is reported where it is armed, and the run itself is counted once, not once per message
      // that waited behind it.
      if (leaseRanOut && !ahead.leaseReported) {
        ahead.leaseReported = true;
        reportTimeout({ kind: 'chat_run_lease', elapsedMs: heldMs, limitMs: this.leaseMs, recovered: true });
      }
    }
    return leaseRanOut;
  }
}
