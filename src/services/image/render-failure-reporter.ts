// A picture that could not be made or sent for a reason other than time (the worker threw, the upload
// was rejected) is reported to the owner's repair flow (alerts queue -> hcb-alert-watcher -> omp
// investigation), as its own alert kind. Timeouts take the other road, reportTimeout({kind:'render'}).
//
// Aggregated: at most one alert per window, carrying how many failures were held back since the last
// one. A broken browser fails every picture the same way and must not flood the queue. The text holds
// the picture kind, the job type, the error class name and durations: never the user's request,
// event titles, a table, an error message or any chat/user id.
import type { RenderFailureReport } from './image-delivery.ts';

/** The `source` of the alerts-table row; the watcher's brief keys on it. */
export const RENDER_FAILURE_ALERT_SOURCE = 'render-failure';
export const RENDER_FAILURE_WINDOW_MS = 10 * 60_000;
/** A held summary the alert queue refused (database locked) is tried again after this long. */
export const RENDER_FAILURE_RETRY_MS = 60_000;

/** Runs `fn` after `delayMs` without keeping the process alive. */
function defaultSchedule(fn: () => void, delayMs: number): void {
  setTimeout(fn, delayMs).unref();
}

export class RenderFailureReporter {
  private lastPushedAt = -Infinity;
  private held = 0;
  /** The newest report held back; it describes the alert sent when the window ends. */
  private heldReport: RenderFailureReport | null = null;
  private timerScheduled = false;

  constructor(
    private readonly push: (text: string, source: string) => void,
    private readonly now: () => number = Date.now,
    private readonly schedule: (fn: () => void, delayMs: number) => void = defaultSchedule,
  ) {}

  report(report: RenderFailureReport): void {
    const waitMs = this.lastPushedAt + RENDER_FAILURE_WINDOW_MS - this.now();
    if (waitMs > 0) {
      // A burst inside the window is not lost: one summary alert goes out when the window ends.
      this.held++;
      this.heldReport = report;
      if (!this.timerScheduled) {
        this.timerScheduled = true;
        this.schedule(() => this.sendHeld(), waitMs);
      }
      return;
    }
    if (this.send(report)) return;
    // The queue refused the first failure of the window (database locked): it is held like a burst member and
    // tried again, so a lone failure is not lost and a later alert counts it.
    this.held++;
    this.heldReport = report;
    if (!this.timerScheduled) {
      this.timerScheduled = true;
      this.schedule(() => this.sendHeld(), RENDER_FAILURE_RETRY_MS);
    }
  }

  /**
   * A timer fired: send the summary. Never inside a window another alert opened meanwhile (a retry timer outlives
   * the alert that a later report sent directly): the summary then waits for that window's end. A refused push
   * keeps it held and tries again, so a locked database does not lose it.
   */
  private sendHeld(): void {
    const pending = this.heldReport;
    if (!pending) {
      this.timerScheduled = false;
      return;
    }
    const waitMs = this.lastPushedAt + RENDER_FAILURE_WINDOW_MS - this.now();
    if (waitMs > 0) {
      this.schedule(() => this.sendHeld(), waitMs);
      return;
    }
    if (this.send(pending)) {
      this.timerScheduled = false;
      return;
    }
    this.schedule(() => this.sendHeld(), RENDER_FAILURE_RETRY_MS);
  }

  /** Shutdown: sends the summary still held for the window's end, so a deploy right after a burst does not lose it. */
  flush(): void {
    if (this.heldReport) this.send(this.heldReport);
  }

  /** True when the alert reached the queue (the held summary, if any, is then spent). */
  private send(report: RenderFailureReport): boolean {
    const uncertain = report.errorName === 'UncertainSend';
    const text = [
      uncertain ? 'Picture upload outcome unknown (render-failure)' : 'Picture delivery failed (render-failure)',
      `kind: ${report.kind}`,
      `jobType: ${report.jobType}`,
      `error: ${report.errorName}`,
      `elapsedMs: ${Math.round(report.elapsedMs)}`,
      `held back since the last alert: ${this.held}`,
      uncertain
        ? 'The upload started and its end is unknown: the picture may have reached the chat. The user was NOT told it failed.'
        : 'The user got one short note and the text answer. Look for "Image delivery failed" and "Image delivery outcome" (outcome=failed) in the container log on root@odroidn2.',
    ].join('\n');
    try {
      this.push(text, RENDER_FAILURE_ALERT_SOURCE);
      this.lastPushedAt = this.now();
      this.held = 0;
      this.heldReport = null;
      return true;
    } catch {
      // The alert queue is a side channel: failing to reach it must never fail the delivery path.
      return false;
    }
  }
}
