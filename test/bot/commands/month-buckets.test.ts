// Characterization of /month day bucketing: the text counts and the rendered image must agree on
// which local day an occurrence belongs to, including occurrences that cross midnight in the user's zone.
import { describe, expect, mock, setSystemTime, test } from 'bun:test';
import { handleMonth } from '../../../src/bot/commands/month.ts';
import { png } from '../../fixtures/png.ts';

type MonthArgs = Parameters<typeof handleMonth>;

const MOSCOW_USER = { telegram_id: 100, language: 'en' as const, timezone: 'Europe/Moscow' };

function occurrence(id: number, startUtc: string) {
  return {
    occurrence_start: startUtc,
    occurrence_end: null,
    event: { id, title: `E${id}`, all_day: 0, event_type: 'event' },
  };
}

// 2026-06-01T21:30Z is 2026-06-02 00:30 in Moscow: the second must be counted on day 2, not day 1.
const OCCURRENCES = [
  occurrence(1, '2026-06-01T21:30:00.000Z'),
  occurrence(2, '2026-06-02T10:00:00.000Z'),
  occurrence(3, '2026-06-15T10:00:00.000Z'),
];

function makeCtx() {
  return {
    dbUser: MOSCOW_USER,
    send: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    sendPhoto: mock(() => Promise.resolve({ id: 42 })),
    bot: { api: { pinChatMessage: mock(() => Promise.resolve()), sendMessage: mock(() => Promise.resolve()) } },
  };
}

function makeEventService() {
  return { getEventsInRange: mock(() => OCCURRENCES) };
}

describe('handleMonth bucketing', () => {
  test('queries the whole local month in UTC and prints per-local-day counts', async () => {
    const ctx = makeCtx();
    const service = makeEventService();

    await handleMonth(ctx as unknown as MonthArgs[0], service as unknown as MonthArgs[1], '2026-06');

    expect(service.getEventsInRange).toHaveBeenCalledWith(
      100,
      '2026-06-01T00:00:00.000+03:00',
      '2026-06-30T23:59:59.999+03:00',
    );
    const [text, options] = ctx.editText.mock.calls[0] as unknown as [string, { parse_mode: string }];
    expect(options.parse_mode).toBe('HTML');
    expect(text).toBe(
      [
        '📅 June 2026',
        '',
        '<code>Mo Tu We Th Fr Sa Su',
        ' 1  2  3  4  5  6  7 ',
        ' 8  9 10 11 12 13 14 ',
        '15 16 17 18 19 20 21 ',
        '22 23 24 25 26 27 28 ',
        '29 30</code>',
        '',
        'Events: 2·2  15·1',
      ].join('\n'),
    );
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('navigation callbacks never render an image', async () => {
    const ctx = makeCtx();
    const renderDirect = mock(() => Promise.resolve(png()));

    await handleMonth(ctx as unknown as MonthArgs[0], makeEventService() as unknown as MonthArgs[1], '2026-06', {
      renderDirect,
    } as unknown as MonthArgs[3]);

    expect(renderDirect).not.toHaveBeenCalled();
    expect(ctx.sendPhoto).not.toHaveBeenCalled();
  });

  test('the image buckets events by local day and marks today', async () => {
    // /month renders the current month, so pin the clock inside June 2026.
    setSystemTime(new Date('2026-06-20T12:00:00.000Z'));
    try {
      const ctx = makeCtx();
      const renderDirect = mock((_job: unknown) => Promise.resolve(png()));

      await handleMonth(ctx as unknown as MonthArgs[0], makeEventService() as unknown as MonthArgs[1], undefined, {
        renderDirect,
      } as unknown as MonthArgs[3]);

      const job = renderDirect.mock.calls[0]![0] as {
        data: { weeks: { dayNumber: number; isOtherMonth: boolean; isToday: boolean; eventCount: number }[][] };
      };
      const days = job.data.weeks.flat().filter((d) => !d.isOtherMonth);
      const counts = Object.fromEntries(days.filter((d) => d.eventCount > 0).map((d) => [d.dayNumber, d.eventCount]));
      expect(counts).toEqual({ 2: 2, 15: 1 });
      expect(days.filter((d) => d.isToday).map((d) => d.dayNumber)).toEqual([20]);
    } finally {
      setSystemTime();
    }
  });
});
