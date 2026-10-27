import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest } from '../../src/services/ai/tool-executor.ts';
import type { EventSummary } from '../../src/services/intent/variable-resolver.ts';
import type { ImageRenderJob } from '../../src/worker/image-render.queue.ts';
import { png } from '../fixtures/png.ts';
import {
  createFixture,
  type Fixture,
  type FixtureOptions,
  mutationCalls,
  NOW,
  OTHER,
  USER,
} from './canonical-basis-helpers.ts';

// ─── real SQLite: real tools, real repositories, real pipeline layer ──────────────────────────────────

let db: Database;
beforeEach(() => {
  _resetToolThrottleForTest();
  setSystemTime(NOW);
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
});
afterEach(() => {
  setSystemTime();
  db.close();
});

const fixture = (options: FixtureOptions = {}): Fixture => createFixture(db, options);

describe('a day plan just after midnight against real SQLite', () => {
  // Mon 2026-09-14 01:22 in Belgrade (UTC+2): 'План на завтра' answered with an empty Tuesday
  // while the user meant Monday, which had four events.
  const AFTER_MIDNIGHT = new Date('2026-09-13T23:22:00Z');

  function mondayFixture(language: 'en' | 'ru' = 'ru'): Fixture {
    const f = fixture({ language });
    f.addEvent('Стендап', '2026-09-14T10:00:00+02:00');
    f.addEvent('Стоматолог', '2026-09-14T12:30:00+02:00');
    f.addEvent('Спортзал', '2026-09-14T18:00:00+02:00');
    f.addEvent('Ужин', '2026-09-14T20:00:00+02:00');
    return f;
  }
  const MONDAY_ROWS = ['10:00  Стендап', '12:30  Стоматолог', '18:00  Спортзал', '20:00  Ужин'];
  const daysRead = (f: Fixture) =>
    f.call.mock.calls.map(([name, input]) => {
      expect(name).toBe('get_events');
      const { start_date, end_date } = input as { start_date: string; end_date: string };
      expect(end_date).toBe(start_date);
      return start_date;
    });
  const sections = (f: Fixture) => f.lastText().split('\n\n');

  test("'План на завтра' at 01:22 reads Monday and Tuesday and labels each with its weekday and date", async () => {
    setSystemTime(AFTER_MIDNIGHT);
    const f = mondayFixture();

    expect(await f.say('План на завтра')).toMatchObject({ handled: true });

    expect(f.call.mock.calls).toEqual([
      ['get_events', { start_date: '2026-09-14', end_date: '2026-09-14', scope: 'personal' }],
      ['get_events', { start_date: '2026-09-15', end_date: '2026-09-15', scope: 'personal' }],
    ]);
    const [monday, tuesday, ...rest] = sections(f);
    expect(rest).toEqual([]);
    expect(monday).toBe(['Сегодня, пн 14.09:', ...MONDAY_ROWS].join('\n'));
    expect(tuesday?.split('\n')[0]).toBe('Завтра, вт 15.09:');
    expect(tuesday).toContain('15 сентября');
    expect(tuesday).not.toContain('Стендап');
  });

  test("'План на сегодня' at 01:22 reads Sunday and Monday, each labelled", async () => {
    setSystemTime(AFTER_MIDNIGHT);
    const f = mondayFixture();

    await f.say('План на сегодня');

    expect(daysRead(f)).toEqual(['2026-09-13', '2026-09-14']);
    const [sunday, monday, ...rest] = sections(f);
    expect(rest).toEqual([]);
    expect(sunday?.split('\n')[0]).toBe('Вчера, вс 13.09:');
    expect(sunday).toContain('13 сентября');
    expect(monday).toBe(['Сегодня, пн 14.09:', ...MONDAY_ROWS].join('\n'));
  });

  test("'План на завтра' at 10:00 reads only Tuesday and answers without day labels", async () => {
    setSystemTime(new Date('2026-09-14T08:00:00Z'));
    const f = mondayFixture();
    f.addEvent('Урок', '2026-09-15T09:00:00+02:00');

    await f.say('План на завтра');

    expect(f.call.mock.calls).toEqual([
      ['get_events', { start_date: '2026-09-15', end_date: '2026-09-15', scope: 'personal' }],
    ]);
    const text = f.lastText();
    expect(text).toContain('09:00  Урок');
    expect(text).not.toContain('Стендап');
    expect(text).not.toContain('Сегодня');
  });

  test('both days are read from 00:00 up to, not including, 04:00', async () => {
    const f = mondayFixture();
    const tomorrowAt = async (utc: string) => {
      setSystemTime(new Date(utc));
      f.call.mockClear();
      await f.say('План на завтра');
      return daysRead(f);
    };
    expect(await tomorrowAt('2026-09-13T21:59:00Z')).toEqual(['2026-09-14']); // Sun 23:59
    expect(await tomorrowAt('2026-09-13T22:00:00Z')).toEqual(['2026-09-14', '2026-09-15']); // Mon 00:00
    expect(await tomorrowAt('2026-09-14T01:59:00Z')).toEqual(['2026-09-14', '2026-09-15']); // Mon 03:59
    expect(await tomorrowAt('2026-09-14T02:00:00Z')).toEqual(['2026-09-15']); // Mon 04:00
  });

  test('an English request gets English day labels', async () => {
    setSystemTime(AFTER_MIDNIGHT);
    const f = mondayFixture('en');

    await f.say("what's tomorrow");

    const [monday, tuesday] = sections(f);
    expect(monday?.split('\n')[0]).toBe('Today, Mon 09/14:');
    expect(tuesday?.split('\n')[0]).toBe('Tomorrow, Tue 09/15:');
  });

  test('a date or another day word is never doubled after midnight', async () => {
    setSystemTime(AFTER_MIDNIGHT);
    const f = mondayFixture();
    await f.say('План на послезавтра');
    await f.say('План на 15 сентября');
    await f.say('План на вчера');
    expect(daysRead(f)).toEqual(['2026-09-16', '2026-09-15', '2026-09-13']);
  });

  test('free time for tomorrow keeps its single calendar day after midnight', async () => {
    setSystemTime(AFTER_MIDNIGHT);
    const f = mondayFixture();
    await f.say('когда я свободен завтра');
    expect(f.call.mock.calls).toEqual([['get_free_slots', { date: '2026-09-15', scope: 'personal' }]]);
  });
});

describe('creating an event against real SQLite', () => {
  test('nothing is written before the answer; yes writes once; a repeated yes writes nothing more', async () => {
    const f = fixture();
    expect(await f.say('create standup tomorrow at 10:30')).toEqual({ handled: true });
    expect(f.eventRows()).toEqual([]);
    expect(mutationCalls(f)).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
    await f.yes();
    const rows = f.eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('standup');
    expect(Date.parse(rows[0]!.start_at)).toBe(Date.parse('2026-09-20T10:30:00+02:00'));
    expect(f.store.get(USER, USER)).toBeNull();
    const again = await f.say('Yes');
    expect(again.handled).toBe(false);
    expect(f.eventRows()).toHaveLength(1);
    expect(mutationCalls(f)).toHaveLength(1);
  });

  test('cancelling leaves the calendar unchanged and clears the pending question', async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    await f.no();
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
    expect(mutationCalls(f)).toEqual([]);
  });

  test('the pending date stays frozen when the answer arrives after midnight', async () => {
    setSystemTime(new Date('2026-09-19T21:59:00Z'));
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    setSystemTime(new Date('2026-09-19T22:01:00Z'));
    await f.yes();
    expect(f.eventRows().map((row) => Date.parse(row.start_at))).toEqual([Date.parse('2026-09-20T10:30:00+02:00')]);
  });

  test('past, ambiguous, skipped and bare-hour times fall through with no write and no tool call', async () => {
    const f = fixture();
    for (const text of [
      'create standup yesterday at 10:30',
      'create standup 2026-10-25 at 02:30',
      'create standup 2027-03-28 at 02:30',
      'create standup tomorrow at 10',
      'create standup 31 февраля в 10:30',
    ]) {
      expect((await f.say(text)).handled, text).toBe(false);
    }
    expect(f.call).not.toHaveBeenCalled();
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
  });

  test('a hostile title is stored verbatim and shown escaped', async () => {
    const f = fixture();
    await f.say('create <b>{{user.id}}</b> & co tomorrow at 10:30');
    const prompt = f.lastText();
    expect(prompt).not.toContain('<b>');
    expect(prompt).toContain('&lt;b&gt;');
    await f.yes();
    expect(f.eventRows()[0]!.title).toBe('<b>{{user.id}}</b> & co');
  });

  test("another person or another chat cannot answer someone else's question", async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    expect((await f.say('Yes', { as: OTHER, chat: USER })).handled).toBe(false);
    expect((await f.say('Yes', { chat: 999 })).handled).toBe(false);
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
    await f.yes();
    expect(f.eventRows()).toHaveLength(1);
  });

  test('an answer that is not one of the offered choices does not write and keeps the question', async () => {
    const f = fixture();
    await f.say('create standup tomorrow at 10:30');
    await f.say('maybe later');
    expect(f.eventRows()).toEqual([]);
    expect(f.store.get(USER, USER)).not.toBeNull();
  });
});

describe('a week plan against real SQLite', () => {
  test('on a Sunday evening it lists the coming days, not the week already gone', async () => {
    // 2026-09-27 23:15 Belgrade: 'План на неделю' listed Tuesday 22 – Friday 25 and
    // nothing from Monday 28 on.
    setSystemTime(new Date('2026-09-27T21:15:00Z'));
    const f = fixture();
    f.addEvent('Concert', '2026-09-22T18:30:00+02:00');
    f.addEvent('Lesson', '2026-09-28T12:30:00+02:00');
    f.addEvent('Vet', '2026-10-03T13:00:00+02:00');
    f.addEvent('Next Sunday', '2026-10-04T10:00:00+02:00');

    expect(await f.say('План на неделю')).toMatchObject({ handled: true });

    expect(f.call.mock.calls[0]).toEqual([
      'get_events',
      { start_date: '2026-09-27', end_date: '2026-10-03', scope: 'personal' },
    ]);
    const text = f.lastText();
    expect(text).toContain('2026-09-28 12:30  Lesson');
    expect(text).toContain('Vet');
    expect(text).not.toContain('Concert');
    expect(text).not.toContain('Next Sunday');
  });
});

describe('a week picture against real SQLite', () => {
  async function weekPicture(now: string) {
    setSystemTime(new Date(now));
    const jobs: ImageRenderJob[] = [];
    const f = fixture({
      language: 'ru',
      renderer: {
        renderDirect: async (job) => {
          jobs.push(job);
          return png();
        },
      },
    });
    f.addEvent('Concert', '2026-09-22T18:30:00+02:00');
    f.addEvent('Lesson', '2026-09-28T12:30:00+02:00');
    expect(await f.say('покажи календарь картинкой на этой неделе')).toMatchObject({ handled: true });
    const job = jobs[0];
    if (job?.type !== 'weekly-overview') throw new Error(`expected a weekly picture, got ${job?.type}`);
    const shown = job.data.days.map((day) => ({
      day: day.dayNumber,
      events: day.events.map((event) => event.title),
    }));
    return { call: f.call.mock.calls[0], shown, reply: f.lastText() };
  }

  test('on a Sunday evening the picture is the coming week, and the reply names it', async () => {
    // 2026-09-27 23:15 Belgrade: the picture showed Monday 21 – Sunday 27, a week already gone.
    const { call, shown, reply } = await weekPicture('2026-09-27T21:15:00Z');
    expect(call).toEqual(['render_week_image', { week_start: '2026-09-28', scope: 'personal' }]);
    expect(shown).toEqual([
      { day: 28, events: ['Lesson'] },
      { day: 29, events: [] },
      { day: 30, events: [] },
      { day: 1, events: [] },
      { day: 2, events: [] },
      { day: 3, events: [] },
      { day: 4, events: [] },
    ]);
    expect(reply).toContain('28 сентября – 4 октября 2026');
  });

  test('on a Saturday the picture is the coming week too', async () => {
    const { call, shown, reply } = await weekPicture('2026-09-26T08:00:00Z');
    expect(call).toEqual(['render_week_image', { week_start: '2026-09-28', scope: 'personal' }]);
    expect(shown.map((day) => day.day)).toEqual([28, 29, 30, 1, 2, 3, 4]);
    expect(reply).toContain('28 сентября – 4 октября 2026');
  });

  test('on a Wednesday the picture is still the current calendar week', async () => {
    const { call, shown, reply } = await weekPicture('2026-09-23T10:00:00Z');
    expect(call).toEqual(['render_week_image', { week_start: '2026-09-21', scope: 'personal' }]);
    expect(shown).toEqual([
      { day: 21, events: [] },
      { day: 22, events: ['Concert'] },
      { day: 23, events: [] },
      { day: 24, events: [] },
      { day: 25, events: [] },
      { day: 26, events: [] },
      { day: 27, events: [] },
    ]);
    expect(reply).toContain('21–27 сентября 2026');
  });
});

describe('deleting by title or number against real SQLite', () => {
  test('several matches: nothing is deleted and nothing is asked', async () => {
    const f = fixture();
    f.addEvent('Sync A');
    f.addEvent('Sync B');
    expect(await f.say('delete event Sync')).toMatchObject({ handled: true });
    expect(f.eventRows()).toHaveLength(2);
    expect(mutationCalls(f)).toEqual([]);
    expect(f.store.get(USER, USER)).toBeNull();
    expect(f.mentioned).not.toHaveBeenCalled();
  });

  test('one match: asks with the event named, deletes once on yes, and a second yes does nothing', async () => {
    const f = fixture();
    f.addEvent('Retro');
    f.addEvent('Planning');
    await f.say('delete event Retro');
    expect(f.lastText()).toContain('Retro');
    expect(f.eventRows()).toHaveLength(2);
    await f.yes();
    expect(f.eventRows().map((row) => row.title)).toEqual(['Planning']);
    expect((await f.say('Yes')).handled).toBe(false);
    expect(mutationCalls(f)).toHaveLength(1);
  });

  test('a number selects that event; cancelling keeps it', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    await f.say(`delete event #${id}`);
    await f.no();
    expect(f.eventRows()).toHaveLength(1);
    await f.say(`delete event #${id}`);
    await f.yes();
    expect(f.eventRows()).toHaveLength(0);
  });

  test('the chosen event is the searched one, not the last mentioned one', async () => {
    const options: { lastMentioned?: EventSummary } = {};
    const f = fixture(options);
    const alpha = f.addEvent('Alpha');
    const beta = f.addEvent('Beta');
    options.lastMentioned = { id: beta, title: 'Beta', date: '2026-10-05', all_day: false };
    await f.say('delete event Alpha');
    await f.yes();
    expect(f.eventRows().map((row) => row.id)).toEqual([beta]);
    expect(alpha).not.toBe(beta);
  });

  test('a bulk request never reaches a write rule', async () => {
    const f = fixture();
    f.addEvent('One');
    f.addEvent('Two');
    for (const text of ['delete all events', 'удали все события', 'delete event all', 'удали событие все'])
      expect((await f.say(text)).handled, text).toBe(false);
    expect(f.eventRows()).toHaveLength(2);
    expect(mutationCalls(f)).toEqual([]);
  });

  test('renaming needs a number or quoted title and asks first', async () => {
    const f = fixture();
    const id = f.addEvent('Retro');
    expect((await f.say('rename event Retro to Planning')).handled).toBe(false);
    await f.say(`rename event #${id} to Planning`);
    expect(f.eventRows()[0]!.title).toBe('Retro');
    await f.yes();
    expect(f.eventRows()[0]!.title).toBe('Planning');
  });
});
