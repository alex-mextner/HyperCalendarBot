import { describe, expect, test } from 'bun:test';
import {
  computeEventColumns,
  computeEventHeight,
  escapeHtml,
  formatDuration,
  formatTime,
  MAX_OVERLAP_COLUMNS,
  MIN_EVENT_DURATION_MIN,
  PX_PER_MIN,
} from '../../../src/worker/templates/helpers.ts';

describe('escapeHtml', () => {
  test('escapes special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  test('escapes ampersand', () => {
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  test('passes through safe strings', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('formatTime', () => {
  test('midnight', () => expect(formatTime(0)).toBe('00:00'));
  test('morning', () => expect(formatTime(570)).toBe('09:30'));
  test('afternoon', () => expect(formatTime(845)).toBe('14:05'));
  test('end of day', () => expect(formatTime(1439)).toBe('23:59'));
});

describe('formatDuration', () => {
  test('minutes only', () => expect(formatDuration(30)).toBe('30min'));
  test('hours only', () => expect(formatDuration(120)).toBe('2h'));
  test('hours and minutes', () => expect(formatDuration(90)).toBe('1h 30min'));
  test('zero', () => expect(formatDuration(0)).toBe(''));
});

describe('computeEventColumns', () => {
  test('single event → column 0, totalColumns 1', () => {
    const result = computeEventColumns([{ startMinutes: 540, endMinutes: 600 }]);
    expect(result).toEqual([{ column: 0, totalColumns: 1 }]);
  });

  test('non-overlapping → all column 0', () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 660, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 1 },
      { column: 0, totalColumns: 1 },
    ]);
  });

  test('two overlapping → columns 0 and 1', () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 660 },
      { startMinutes: 600, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 2 },
      { column: 1, totalColumns: 2 },
    ]);
  });

  test('three overlapping → columns 0, 1, 2', () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 600, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 750 },
    ]);
    expect(result[0]!.column).toBe(0);
    expect(result[1]!.column).toBe(1);
    expect(result[2]!.column).toBe(2);
    for (const r of result) expect(r.totalColumns).toBe(3);
  });

  test('partial overlap chain: A↔B, B↔C, not A↔C', () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 570, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 720 },
    ]);
    expect(result[0]).toEqual({ column: 0, totalColumns: 2 });
    expect(result[1]).toEqual({ column: 1, totalColumns: 2 });
    expect(result[2]).toEqual({ column: 0, totalColumns: 2 });
  });

  test('empty → empty', () => {
    expect(computeEventColumns([])).toEqual([]);
  });
});

describe('layout constants', () => {
  test('PX_PER_MIN is 2', () => expect(PX_PER_MIN).toBe(2));
  test('MIN_EVENT_DURATION_MIN is 15', () => expect(MIN_EVENT_DURATION_MIN).toBe(15));
  test('MAX_OVERLAP_COLUMNS is 4', () => expect(MAX_OVERLAP_COLUMNS).toBe(4));
});

describe('computeEventHeight', () => {
  test('single 5-min event expands to MIN_EVENT_DURATION_MIN * PX_PER_MIN', () => {
    const events = [{ startMinutes: 540, endMinutes: 545 }];
    const cols = computeEventColumns(events);
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(MIN_EVENT_DURATION_MIN * PX_PER_MIN);
  });

  test('30-min event uses actual duration', () => {
    const events = [{ startMinutes: 540, endMinutes: 570 }];
    const cols = computeEventColumns(events);
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60);
  });

  test('sequential 5-min events: first clamped to gap, no visual overlap', () => {
    const events = [
      { startMinutes: 540, endMinutes: 545 },
      { startMinutes: 545, endMinutes: 550 },
    ];
    const cols = computeEventColumns(events);
    // gap = 545-540 = 5min; expanded=15; clamped=min(15,5)=5; max(5,5)*2 = 10
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(10);
    // last event has no next → expands to MIN * PX = 30
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(MIN_EVENT_DURATION_MIN * PX_PER_MIN);
  });

  test('20-min gap allows full minimum expansion', () => {
    const events = [
      { startMinutes: 540, endMinutes: 545 },
      { startMinutes: 560, endMinutes: 600 },
    ];
    const cols = computeEventColumns(events);
    // gap = 560-540 = 20min; expanded=15; min(15,20)=15; *2 = 30
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(MIN_EVENT_DURATION_MIN * PX_PER_MIN);
  });

  test('overlapping events in different columns do not constrain each other', () => {
    const events = [
      { startMinutes: 540, endMinutes: 600 }, // col 0
      { startMinutes: 550, endMinutes: 610 }, // col 1
    ];
    const cols = computeEventColumns(events);
    // no sequential event in same column → full duration
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60 * PX_PER_MIN);
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(60 * PX_PER_MIN);
  });

  test('30-min sequential events use actual height, not clamped', () => {
    const events = [
      { startMinutes: 540, endMinutes: 570 },
      { startMinutes: 570, endMinutes: 600 },
    ];
    const cols = computeEventColumns(events);
    // gap=570-540=30min; expanded=30; min(30,30)=30; max(30,30)*2=60
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(60);
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(60);
  });

  test('three sequential 5-min events: first two clamped, last expanded', () => {
    const events = [
      { startMinutes: 540, endMinutes: 545 },
      { startMinutes: 545, endMinutes: 550 },
      { startMinutes: 550, endMinutes: 555 },
    ];
    const cols = computeEventColumns(events);
    expect(computeEventHeight(events[0]!, 0, events, cols)).toBe(10);
    expect(computeEventHeight(events[1]!, 1, events, cols)).toBe(10);
    expect(computeEventHeight(events[2]!, 2, events, cols)).toBe(MIN_EVENT_DURATION_MIN * PX_PER_MIN);
  });
});
