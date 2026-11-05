import { describe, expect, test } from 'bun:test';
import type { RenderFailureReport } from '../../../src/services/image/image-delivery.ts';
import {
  RENDER_FAILURE_ALERT_SOURCE,
  RENDER_FAILURE_RETRY_MS,
  RENDER_FAILURE_WINDOW_MS,
  RenderFailureReporter,
} from '../../../src/services/image/render-failure-reporter.ts';

const report: RenderFailureReport = { kind: 'week', jobType: 'weekly-overview', errorName: 'Error', elapsedMs: 1234.6 };

/** A reporter on a hand-driven clock; `timers` are the window-end flushes it asked for. */
function reporter(push: (text: string, source: string) => void = () => {}) {
  const clock = { now: 1_000_000 };
  const timers: { fn: () => void; delayMs: number }[] = [];
  return {
    clock,
    timers,
    reporter: new RenderFailureReporter(
      push,
      () => clock.now,
      (fn, delayMs) => timers.push({ fn, delayMs }),
    ),
  };
}

describe('RenderFailureReporter', () => {
  test('the first failure raises an alert of its own kind, with identifiers only', () => {
    const pushed: [string, string][] = [];
    const { reporter: r } = reporter((text, source) => pushed.push([text, source]));
    r.report(report);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]![1]).toBe(RENDER_FAILURE_ALERT_SOURCE);
    expect(pushed[0]![0]).toContain('Picture delivery failed (render-failure)');
    expect(pushed[0]![0]).toContain('kind: week');
    expect(pushed[0]![0]).toContain('jobType: weekly-overview');
    expect(pushed[0]![0]).toContain('elapsedMs: 1235');
    expect(pushed[0]![0]).toContain('held back since the last alert: 0');
  });

  test('a burst inside the window is one alert now and ONE summary when the window ends, with no later report needed', () => {
    const pushed: string[] = [];
    const { clock, timers, reporter: r } = reporter((text) => pushed.push(text));
    r.report(report);
    r.report(report);
    r.report(report);
    expect(pushed).toHaveLength(1);
    expect(timers).toHaveLength(1); // one flush for the whole burst
    expect(timers[0]!.delayMs).toBe(RENDER_FAILURE_WINDOW_MS);

    clock.now += RENDER_FAILURE_WINDOW_MS;
    timers[0]!.fn();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('held back since the last alert: 2');
  });

  test('a report after the window sends at once and the pending flush then sends nothing more', () => {
    const pushed: string[] = [];
    const { clock, timers, reporter: r } = reporter((text) => pushed.push(text));
    r.report(report);
    r.report(report);
    clock.now += RENDER_FAILURE_WINDOW_MS;
    r.report(report);
    expect(pushed).toHaveLength(2);
    timers[0]!.fn();
    expect(pushed).toHaveLength(2);
  });

  test('an upload of unknown end is described as unknown, not as a failure the user was told about', () => {
    const pushed: string[] = [];
    const { reporter: r } = reporter((text) => pushed.push(text));
    r.report({ ...report, errorName: 'UncertainSend' });
    expect(pushed[0]).toContain('outcome unknown');
    expect(pushed[0]).toContain('The user was NOT told it failed');
    expect(pushed[0]).not.toContain('The user got one short note');
  });

  test('an unreachable alert queue never fails the delivery path', () => {
    const { reporter: r } = reporter(() => {
      throw new Error('database is locked');
    });
    expect(() => r.report(report)).not.toThrow();
    expect(() => r.report(report)).not.toThrow();
  });

  test('a first failure the alert queue refuses is held and sent by the retry, so a lone failure is not lost', () => {
    const pushed: string[] = [];
    let locked = true;
    const { timers, reporter: r } = reporter((text) => {
      if (locked) throw new Error('database is locked');
      pushed.push(text);
    });
    r.report(report);
    expect(pushed).toHaveLength(0);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(RENDER_FAILURE_RETRY_MS);

    locked = false;
    timers[0]!.fn();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('kind: week');
    expect(pushed[0]).toContain('held back since the last alert: 1'); // itself, counted
    expect(timers).toHaveLength(1); // nothing more to retry
  });

  test('a retry timer left over from a refused first failure does not open a second alert inside the window another report started', () => {
    const pushed: string[] = [];
    let locked = true;
    const {
      clock,
      timers,
      reporter: r,
    } = reporter((text) => {
      if (locked) throw new Error('database is locked');
      pushed.push(text);
    });
    const start = clock.now;
    r.report(report); // refused: held, a retry timer set for RENDER_FAILURE_RETRY_MS
    locked = false;
    clock.now = start + 10_000;
    r.report({ ...report, kind: 'day' }); // sent directly: this opens the window (alert 1)
    clock.now = start + 30_000;
    r.report({ ...report, kind: 'month' }); // inside that window: held, no new timer
    expect(pushed).toHaveLength(1);

    clock.now = start + RENDER_FAILURE_RETRY_MS;
    timers[0]!.fn(); // the old retry timer fires inside the window
    expect(pushed).toHaveLength(1); // not a second alert 50 s after the first
    expect(timers[1]!.delayMs).toBe(RENDER_FAILURE_WINDOW_MS - (RENDER_FAILURE_RETRY_MS - 10_000));

    clock.now = start + 10_000 + RENDER_FAILURE_WINDOW_MS;
    timers[1]!.fn();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('kind: month');
  });

  test('a summary the alert queue refuses at the window end stays held and is tried again, not lost', () => {
    const pushed: string[] = [];
    let locked = false;
    const {
      clock,
      timers,
      reporter: r,
    } = reporter((text) => {
      if (locked) throw new Error('database is locked');
      pushed.push(text);
    });
    r.report(report);
    r.report(report);
    r.report({ ...report, kind: 'day' });
    expect(pushed).toHaveLength(1);

    clock.now += RENDER_FAILURE_WINDOW_MS;
    locked = true;
    timers[0]!.fn();
    expect(pushed).toHaveLength(1);
    expect(timers).toHaveLength(2);
    expect(timers[1]!.delayMs).toBe(RENDER_FAILURE_RETRY_MS);

    locked = false;
    timers[1]!.fn();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain('kind: day');
    expect(pushed[1]).toContain('held back since the last alert: 2');
    expect(timers).toHaveLength(2); // nothing more to retry
  });

  describe('flush (shutdown)', () => {
    test('sends the summary still held for the window at once, so a deploy after a burst does not lose it', () => {
      const pushed: [string, string][] = [];
      const { reporter: r } = reporter((text, source) => pushed.push([text, source]));
      r.report(report);
      r.report({ ...report, kind: 'month' });
      r.report({ ...report, kind: 'day' });
      expect(pushed).toHaveLength(1); // the first went out, two are held back

      r.flush();

      expect(pushed).toHaveLength(2);
      expect(pushed[1]![1]).toBe(RENDER_FAILURE_ALERT_SOURCE);
      expect(pushed[1]![0]).toContain('kind: day'); // the newest held report describes the summary
      expect(pushed[1]![0]).toContain('held back since the last alert: 2');
    });

    test('with nothing held there is no alert, with or without an earlier alert', () => {
      const pushed: string[] = [];
      const { reporter: r } = reporter((text) => pushed.push(text));
      r.flush();
      expect(pushed).toEqual([]);

      r.report(report); // sent at once, nothing held
      r.flush();
      expect(pushed).toHaveLength(1);
    });

    test('is idempotent, and the window-end timer that fires afterwards sends nothing more', () => {
      const pushed: string[] = [];
      const { clock, timers, reporter: r } = reporter((text) => pushed.push(text));
      r.report(report);
      r.report(report);
      r.flush();
      r.flush();
      expect(pushed).toHaveLength(2);

      clock.now += RENDER_FAILURE_WINDOW_MS;
      timers[0]!.fn();
      expect(pushed).toHaveLength(2);
    });
  });
});
