// The benchmark never reports a rate without its sample size and a 95% interval, and a rate over no cases is null.
import { describe, expect, test } from 'bun:test';
import { intervalsOf, wilson } from '../../../scripts/intent-benchmark/metrics.ts';

describe('wilson interval', () => {
  test('matches published 95% Wilson bounds', () => {
    const half = wilson(5, 10);
    expect(half.low).toBeCloseTo(0.2366, 3);
    expect(half.high).toBeCloseTo(0.7634, 3);
    const none = wilson(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 3);
    const all = wilson(10, 10);
    expect(all.low).toBeCloseTo(0.7225, 3);
    expect(all.high).toBeCloseTo(1, 12);
  });

  test('a zero denominator gives null bounds, never 0 or 1', () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, rate: null, low: null, high: null });
  });

  test('a perfect result on a small sample does not clear 80% with statistical support', () => {
    expect(wilson(11, 11).low ?? 0).toBeLessThan(0.8);
    expect(wilson(16, 16).low ?? 0).toBeGreaterThanOrEqual(0.8);
  });
});

describe('interval denominators', () => {
  test('coverage is over rule-eligible messages, coverage of all is over every message', () => {
    const counts = {
      conversations: 100,
      inScope: 25,
      aiIntentLike: 20,
      aiOther: 55,
      correct: 20,
      wrong: 1,
      missed: 4,
      falseMatch: 0,
      harmfulFalseMatch: 0,
      unconfirmedWrites: 0,
      exceptions: 0,
      rubricClean: 19,
      aiTurnAvoided: 18,
      relabelled: 0,
    };
    const intervals = intervalsOf(counts);
    expect(intervals.coverage).toMatchObject({ k: 20, n: 25 });
    expect(intervals.coverageOfAll).toMatchObject({ k: 20, n: 100 });
    expect(intervals.precision).toMatchObject({ k: 20, n: 21 });
    expect(intervals.rubricPass).toMatchObject({ k: 19, n: 20 });
  });
});
