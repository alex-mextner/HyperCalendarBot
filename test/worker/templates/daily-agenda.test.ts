import { describe, expect, test } from 'bun:test';
import { dailyAgendaTemplate } from '../../../src/worker/templates/daily-agenda.ts';
import { MAX_OVERLAP_COLUMNS, PX_PER_MIN } from '../../../src/worker/templates/helpers.ts';
import { THEME_LIGHT } from '../../../src/worker/templates/themes.ts';
import type { AgendaEvent, DailyAgendaData } from '../../../src/worker/templates/types.ts';

function makeData(overrides: Partial<DailyAgendaData> = {}): DailyAgendaData {
  return {
    date: '2026-03-11',
    dayOfWeek: 'Wednesday',
    dateFormatted: 'March 11, 2026',
    eventCount: 0,
    allDayEvents: [],
    timedEvents: [],
    theme: THEME_LIGHT,
    locale: 'en',
    ...overrides,
  };
}

describe('dailyAgendaTemplate', () => {
  test('renders valid HTML', () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<div id="__root">');
    expect(html).toContain('</html>');
  });

  test('renders date in header', () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain('March 11, 2026');
  });

  test('renders day of week and event count', () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 3 }));
    expect(html).toContain('Wednesday');
    expect(html).toContain('3 events');
  });

  test('Russian event count', () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 5, locale: 'ru' }));
    expect(html).toContain('5 событий');
  });

  test('renders relative day badge', () => {
    const html = dailyAgendaTemplate.render(makeData({ relativeDay: 'Today' }));
    expect(html).toContain('Today');
    expect(html).toContain('header__badge');
  });

  test('empty state when no events', () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain('No events');
  });

  test('Russian empty state', () => {
    const html = dailyAgendaTemplate.render(makeData({ locale: 'ru' }));
    expect(html).toContain('Нет событий');
  });

  test('renders timed events with time and color', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 1,
        timedEvents: [
          {
            id: 1,
            title: 'Standup',
            startMinutes: 540,
            endMinutes: 570,
            calendarColor: '#6366F1',
            isAllDay: false,
          },
        ],
      }),
    );
    expect(html).toContain('Standup');
    expect(html).toContain('09:00');
    expect(html).toContain('09:30');
    expect(html).toContain('#6366F1');
  });

  test('renders all-day events', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 1,
        allDayEvents: [
          {
            id: 2,
            title: 'Company Holiday',
            startMinutes: 0,
            endMinutes: 1440,
            calendarColor: '#EC4899',
            isAllDay: true,
          },
        ],
      }),
    );
    expect(html).toContain('Company Holiday');
    expect(html).toContain('allday');
  });

  test('renders current time indicator', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        currentTimeMinutes: 615,
        eventCount: 1,
        timedEvents: [
          {
            id: 1,
            title: 'Meeting',
            startMinutes: 540,
            endMinutes: 660,
            calendarColor: '#6366F1',
            isAllDay: false,
          },
        ],
      }),
    );
    expect(html).toContain('now-line');
  });

  test('renders holiday badge', () => {
    const html = dailyAgendaTemplate.render(makeData({ isHoliday: true, holidayName: 'New Year' }));
    expect(html).toContain('New Year');
    expect(html).toContain('holiday-badge');
  });

  test('escapes HTML in titles', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 1,
        timedEvents: [
          {
            id: 1,
            title: '<script>alert("x")</script>',
            startMinutes: 540,
            endMinutes: 600,
            calendarColor: '#6366F1',
            isAllDay: false,
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('renders event location', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 1,
        timedEvents: [
          {
            id: 1,
            title: 'Meeting',
            startMinutes: 540,
            endMinutes: 600,
            location: 'Room 42',
            calendarColor: '#6366F1',
            isAllDay: false,
          },
        ],
      }),
    );
    expect(html).toContain('Room 42');
  });

  test('renders footer', () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain('HyperCalendar');
  });
});

// ── Timeline layout tests ────────────────────────────────────────────────────

function ev(id: number, start: number, end: number, color = '#6366F1'): AgendaEvent {
  return { id, title: `Event ${id}`, startMinutes: start, endMinutes: end, calendarColor: color, isAllDay: false };
}

describe('timeline layout', () => {
  test('event top position scales with PX_PER_MIN', () => {
    // minHour = floor(540/60)-1 = 8; top = (540-480)*2 = 120px
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 1, timedEvents: [ev(1, 540, 600)] }));
    expect(html).toContain('top:120px');
  });

  test('hour row height scales with PX_PER_MIN', () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 1, timedEvents: [ev(1, 540, 600)] }));
    expect(html).toContain(`height: ${60 * PX_PER_MIN}px`);
  });

  test('sequential 5-min events: second starts at correct scaled top', () => {
    // minHour=8; ev1 top=(540-480)*2=120; ev2 top=(545-480)*2=130
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 2,
        timedEvents: [ev(1, 540, 545), ev(2, 545, 550)],
      }),
    );
    expect(html).toContain('top:130px'); // ev2 top
    // ev1 height clamped to gap: (545-540)*2 = 10px ≤ COMPACT_PX → compact class
    expect(html).toContain('event-block--compact');
  });

  test('sequential 5-min events: first height ≤ gap to next (no visual overlap)', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 2,
        timedEvents: [ev(1, 540, 545), ev(2, 545, 550)],
      }),
    );
    // ev1 height = min(expand=15, gap=5)*2 = 10px (inline style, no spaces)
    // ev2 top = (545-480)*2 = 130px → ev2 visual top (130) ≥ ev1 top+height (120+10) → no overlap
    expect(html).toContain('height:10px');
    expect(html).toContain('top:130px');
  });

  test('two overlapping events render side by side (50% width each)', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 2,
        timedEvents: [ev(1, 540, 600), ev(2, 560, 620)],
      }),
    );
    expect(html).toContain('width:calc(50% - 8px)');
  });

  test('four overlapping events: all visible, no overflow', () => {
    const events = Array.from({ length: MAX_OVERLAP_COLUMNS }, (_, i) => ev(i + 1, 540, 600));
    const html = dailyAgendaTemplate.render(makeData({ eventCount: events.length, timedEvents: events }));
    expect(html).not.toContain('class="event-block event-block--overflow"');
    // each at 25% width (no overflow → MAX_OVERLAP_COLUMNS columns)
    expect(html).toContain(`width:calc(${100 / MAX_OVERLAP_COLUMNS}% - 8px)`);
  });

  test('five overlapping events: overflow block with title of 5th event', () => {
    const events = Array.from({ length: MAX_OVERLAP_COLUMNS + 1 }, (_, i) => ev(i + 1, 540, 600));
    const html = dailyAgendaTemplate.render(makeData({ eventCount: events.length, timedEvents: events }));
    expect(html).toContain('class="event-block event-block--overflow"');
    expect(html).toContain('overflow-item');
    // Event 5 is the sole overflow event; its title must appear in the overflow block
    expect(html).toContain('>Event 5<');
    // Visible events use MAX_OVERLAP_COLUMNS+1 slots → 20% each
    expect(html).toContain(`width:calc(${100 / (MAX_OVERLAP_COLUMNS + 1)}% - 8px)`);
  });

  test('six overlapping events: two titles in overflow block', () => {
    const events = Array.from({ length: MAX_OVERLAP_COLUMNS + 2 }, (_, i) => ev(i + 1, 540, 600));
    const html = dailyAgendaTemplate.render(makeData({ eventCount: events.length, timedEvents: events }));
    expect(html).toContain('>Event 5<');
    expect(html).toContain('>Event 6<');
  });

  test('overflow block shows "+N more" when titles exceed MAX_OVERFLOW_LABELS', () => {
    // MAX_OVERLAP_COLUMNS=4 visible + 4 overflow events
    const events = Array.from({ length: MAX_OVERLAP_COLUMNS + 4 }, (_, i) => ev(i + 1, 540, 600));
    const html = dailyAgendaTemplate.render(makeData({ eventCount: events.length, timedEvents: events }));
    // First 3 overflow titles shown (Event 5, 6, 7), Event 8 collapsed to "+1 more"
    expect(html).toContain('>Event 5<');
    expect(html).toContain('>Event 7<');
    expect(html).toContain('+1 more');
    expect(html).not.toContain('>Event 8<');
  });

  test('overlapping events with different start times: both shown side by side', () => {
    // A: 9:00–10:00, B: 9:30–11:00 — overlap, different starts
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 2,
        timedEvents: [ev(1, 540, 600), ev(2, 570, 660)],
      }),
    );
    expect(html).toContain('Event 1');
    expect(html).toContain('Event 2');
    expect(html).toContain('width:calc(50% - 8px)');
    expect(html).not.toContain('class="event-block event-block--overflow"');
  });

  test('three events with staggered starts: all shown in 3 columns', () => {
    // A: 9:00–10:30, B: 9:15–10:00, C: 9:45–11:00 — all overlap transitively
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 3,
        timedEvents: [ev(1, 540, 630), ev(2, 555, 600), ev(3, 585, 660)],
      }),
    );
    expect(html).toContain('Event 1');
    expect(html).toContain('Event 2');
    expect(html).toContain('Event 3');
    expect(html).not.toContain('class="event-block event-block--overflow"');
    expect(html).toContain(`width:calc(${100 / 3}% - 8px)`);
  });

  test('two non-overlapping groups rendered independently', () => {
    // Morning group: A+B overlap; afternoon group: C alone
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 3,
        timedEvents: [ev(1, 540, 600), ev(2, 570, 660), ev(3, 840, 900)],
      }),
    );
    // Morning group: 2 columns → 50% width
    expect(html).toContain('width:calc(50% - 8px)');
    // Afternoon event: 1 column → 100% width
    expect(html).toContain('width:calc(100% - 8px)');
  });

  test('compact class applied to short events below COMPACT_PX threshold', () => {
    // Two sequential 5-min events; first is clamped to 10px < COMPACT_PX=30
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 2,
        timedEvents: [ev(1, 540, 545), ev(2, 545, 550)],
      }),
    );
    expect(html).toContain('event-block--compact');
  });

  test('30-min event is not compact', () => {
    const html = dailyAgendaTemplate.render(
      makeData({
        eventCount: 1,
        timedEvents: [ev(1, 540, 570)],
      }),
    );
    // height = 30*2 = 60px > COMPACT_PX=30 → no compact class
    expect(html).not.toContain('class="event-block event-block--compact"');
  });
});
