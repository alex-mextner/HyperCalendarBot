// One place every timeout the bot hits is reported to the owner's repair flow (alerts queue ->
// hcb-alert-watcher -> investigation). A timeout absorbed by a fallback (`recovered: true`) is
// still counted, so a capacity trend is visible; an unrecovered one is an incident.
//
// Alerts are aggregated per kind: at most one per kind per window, carrying how many timeouts were
// held back since the last alert and their recovered / unrecovered split. Timeouts held back inside
// a window are flushed when the window ends, so a lone unrecovered timeout that follows a recovered
// one is never lost; a flush re-checks the window, so a late timer cannot break the rate limit.
// A push the queue refused is retried a minute apart a few times, then once per window until the
// queue takes it: nothing held is dropped while the process lives, and `flush()` sends what is
// still held at shutdown. The kinds share one queue, so one refusal delays every kind's next try.
// The alert holds no message text, user ids or titles: only the kind, a request id, durations and
// counts. `kind` and `requestId` are internal values and must never carry external input.

/** The `source` of the alerts-table row; the watcher's brief keys on it. */
export const TIMEOUT_ALERT_SOURCE = 'timeout';
export const TIMEOUT_ALERT_WINDOW_MS = 10 * 60_000;
/** How long after a refused push the next attempt waits, and how many refusals in a row end the short retries. */
export const TIMEOUT_ALERT_RETRY_MS = 60_000;
export const MAX_PUSH_ATTEMPTS = 5;

export interface TimeoutReport {
  /** What timed out: 'validator', 'render', 'provider', 'http', 'redis', 'db', 'scheduler', ... */
  kind: string;
  requestId?: string;
  /** How long the operation ran before it was cut. */
  elapsedMs: number;
  /** The limit that cut it. */
  limitMs: number;
  /** A fallback or retry still produced the result the user needed. */
  recovered: boolean;
}

interface KindWindow {
  lastPushedAt: number;
  recovered: number;
  unrecovered: number;
  /** The newest report not yet sent; it describes the next alert. */
  held: TimeoutReport | null;
  /** The report that arrived while this kind's push was in progress; it only counts until the push settles. */
  late: TimeoutReport | null;
  timerScheduled: boolean;
  /** A push to the queue is in progress; reports that arrive meanwhile only count. */
  sending: boolean;
}

/** The report that should describe an alert: an unrecovered timeout is never hidden by a recovered one. */
function describing(current: TimeoutReport | null, next: TimeoutReport): TimeoutReport {
  return !next.recovered || !current || current.recovered ? next : current;
}

/** Runs `fn` after `delayMs` without keeping the process alive. */
function defaultSchedule(fn: () => void, delayMs: number): void {
  setTimeout(fn, delayMs).unref();
}

export class TimeoutReporter {
  private readonly kinds = new Map<string, KindWindow>();
  /** The earliest time the queue may be tried again after it refused a push; shared by every kind. */
  private queueNextAttemptAt = -Infinity;
  /** Refusals in a row since the queue last took an alert. */
  private failedPushes = 0;

  constructor(
    private readonly push: (text: string, source: string) => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, delayMs: number) => void = defaultSchedule,
  ) {}

  report(report: TimeoutReport): void {
    const window = this.kinds.get(report.kind) ?? {
      lastPushedAt: -Infinity,
      recovered: 0,
      unrecovered: 0,
      held: null,
      late: null,
      timerScheduled: false,
      sending: false,
    };
    this.kinds.set(report.kind, window);
    if (report.recovered) window.recovered++;
    else window.unrecovered++;
    // A push in progress (the queue timing out on its own) only counts; the send settles the rest afterwards.
    if (window.sending) {
      window.late = describing(window.late, report);
      return;
    }
    window.held = describing(window.held, report);
    this.settle(window);
  }

  /**
   * Sends every held report now, ignoring the window, for shutdown before the queue's database closes.
   * Stops at the first refusal: a queue that refuses is not hammered once per kind. Returns one line
   * per kind that stays unsent, with its counts.
   */
  flush(): string[] {
    const unsent: string[] = [];
    let refused = false;
    for (const [kind, window] of this.kinds) {
      if (!window.held || window.sending) continue;
      if (!refused && this.send(window.held, window)) continue;
      refused = true;
      unsent.push(`${kind} unrecovered=${window.unrecovered} recovered=${window.recovered}`);
    }
    return unsent;
  }

  /** Sends the held report when the window allows, otherwise makes sure a timer will. */
  private settle(window: KindWindow): void {
    if (!window.held) return;
    const waitMs = Math.max(window.lastPushedAt + TIMEOUT_ALERT_WINDOW_MS, this.queueNextAttemptAt) - this.now();
    if (waitMs <= 0) {
      this.send(window.held, window);
      return;
    }
    this.scheduleSettle(window, waitMs);
  }

  private scheduleSettle(window: KindWindow, delayMs: number): void {
    if (window.timerScheduled) return;
    window.timerScheduled = true;
    this.schedule(() => {
      window.timerScheduled = false;
      this.settle(window);
    }, delayMs);
  }

  /** True when the queue took the alert. */
  private send(report: TimeoutReport, window: KindWindow): boolean {
    const sent = { recovered: window.recovered, unrecovered: window.unrecovered };
    const text = [
      `Timeout (${report.kind})`,
      ...(report.requestId ? [`requestId: ${report.requestId}`] : []),
      `elapsedMs: ${Math.round(report.elapsedMs)}`,
      `limitMs: ${Math.round(report.limitMs)}`,
      `since the last alert: unrecovered=${sent.unrecovered} recovered=${sent.recovered}`,
      'Unrecovered timeouts are incidents; a burst of recovered ones is a capacity signal.',
    ].join('\n');
    window.sending = true;
    try {
      this.push(text, TIMEOUT_ALERT_SOURCE);
    } catch {
      // The alert queue is a side channel: a timeout report must never fail the operation that timed out.
      window.sending = false;
      if (window.late) window.held = describing(window.held, window.late);
      window.late = null;
      this.afterRefusedPush(window);
      return false;
    }
    window.sending = false;
    window.lastPushedAt = this.now();
    // Timeouts that arrived while the push ran (a queue that itself times out) were counted, not sent:
    // the newest of them describes the alert that carries their counts.
    window.recovered -= sent.recovered;
    window.unrecovered -= sent.unrecovered;
    window.held = window.late;
    window.late = null;
    this.failedPushes = 0;
    this.queueNextAttemptAt = -Infinity;
    this.settle(window);
    return true;
  }

  /**
   * The queue refused the alert: keep it and try again after the retry delay. After a bounded number
   * of attempts in a row the delay grows to a full window and stays there until the queue takes an
   * alert, so a dead queue costs one attempt per window and the incident is still sent once the queue
   * recovers. The count is shared like the queue, so no kind starts over with its own minute-long
   * retries. Reports arriving meanwhile only count; they do not touch the queue before
   * `queueNextAttemptAt`.
   */
  private afterRefusedPush(window: KindWindow): void {
    this.failedPushes++;
    const delayMs = this.failedPushes >= MAX_PUSH_ATTEMPTS ? TIMEOUT_ALERT_WINDOW_MS : TIMEOUT_ALERT_RETRY_MS;
    this.queueNextAttemptAt = this.now() + delayMs;
    this.scheduleSettle(window, delayMs);
  }
}

let reporter: TimeoutReporter | null = null;

/** Bootstrap wires the real alert queue once; until then (tests, dev) reports are dropped. */
export function configureTimeoutReporter(next: TimeoutReporter | null): void {
  reporter = next;
}

export function reportTimeout(report: TimeoutReport): void {
  reporter?.report(report);
}

/**
 * Sends the timeouts still held back inside their window; shutdown calls it before the database
 * closes. Returns one line per kind the queue refused, so shutdown can log what was lost.
 */
export function flushTimeoutReports(): string[] {
  return reporter?.flush() ?? [];
}
