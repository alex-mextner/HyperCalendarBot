// Demo: render sample daily agenda image
// Run: bun run scripts/demo-render.ts

import { PlaywrightPool } from '../src/worker/playwright-pool.ts';
import { dailyAgendaTemplate } from '../src/worker/templates/daily-agenda.ts';
import { eventCardTemplate } from '../src/worker/templates/event-card.ts';
import { THEME_DARK, THEME_LIGHT } from '../src/worker/templates/themes.ts';
import type { DailyAgendaData, EventCardData, WeeklyOverviewData } from '../src/worker/templates/types.ts';
import { weeklyOverviewTemplate } from '../src/worker/templates/weekly-overview.ts';

const pool = new PlaywrightPool({ maxPages: 1, maxUseCount: 10, maxAgeMs: 60_000 });
await pool.initialize();

async function renderToFile(html: string, filename: string) {
  const page = await pool.acquire();
  await page.setContent(html, { waitUntil: 'load' });
  const height = await page.evaluate(() => document.getElementById('__root')?.scrollHeight ?? 800);
  await page.setViewportSize({ width: 1080, height });
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1080, height } });
  await Bun.write(filename, buf);
  await pool.release(page);
  console.log(`✓ ${filename} (${Math.round(buf.byteLength / 1024)}KB, ${height}px tall)`);
}

// --- Daily Agenda (light) ---
const dailyData: DailyAgendaData = {
  date: '2026-03-14',
  dayOfWeek: 'Saturday',
  dateFormatted: 'March 14, 2026',
  relativeDay: 'Today',
  eventCount: 5,
  currentTimeMinutes: 10 * 60 + 30, // 10:30
  isHoliday: false,
  allDayEvents: [
    { id: 1, title: 'Pi Day 🥧', startMinutes: 0, endMinutes: 1440, calendarColor: '#EC4899', isAllDay: true },
  ],
  timedEvents: [
    {
      id: 2,
      title: 'Morning standup',
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      calendarColor: '#6366F1',
      isAllDay: false,
      location: 'Zoom',
    },
    {
      id: 3,
      title: 'Design review',
      startMinutes: 10 * 60,
      endMinutes: 11 * 60,
      calendarColor: '#14B8A6',
      isAllDay: false,
      location: 'Room 42',
    },
    {
      id: 4,
      title: '1:1 with Alex',
      startMinutes: 10 * 60 + 30,
      endMinutes: 11 * 60 + 30,
      calendarColor: '#F59E0B',
      isAllDay: false,
    },
    {
      id: 5,
      title: 'Lunch with team',
      startMinutes: 12 * 60,
      endMinutes: 13 * 60,
      calendarColor: '#EF4444',
      isAllDay: false,
      location: 'Cafe',
    },
  ],
  theme: THEME_LIGHT,
  locale: 'en',
};

const dailyHtml = dailyAgendaTemplate.render(dailyData);
await renderToFile(dailyHtml, '/tmp/daily-agenda-light.png');

// --- Daily Agenda (dark, Russian) ---
const dailyRu: DailyAgendaData = {
  ...dailyData,
  dayOfWeek: 'Суббота',
  dateFormatted: '14 марта 2026',
  relativeDay: 'Сегодня',
  isHoliday: true,
  holidayName: 'День числа Пи',
  theme: THEME_DARK,
  locale: 'ru',
};

const dailyRuHtml = dailyAgendaTemplate.render(dailyRu);
await renderToFile(dailyRuHtml, '/tmp/daily-agenda-dark-ru.png');

// --- Weekly Overview ---
const weekData: WeeklyOverviewData = {
  weekLabel: 'March 9–15, 2026',
  todayIndex: 5, // Saturday
  days: [
    {
      dayNumber: 9,
      dayName: 'Mon',
      eventCount: 3,
      isWeekend: false,
      events: [
        { title: 'Standup', startMinutes: 540, endMinutes: 570, color: '#6366F1', isAllDay: false },
        { title: 'Design sync', startMinutes: 660, endMinutes: 720, color: '#14B8A6', isAllDay: false },
        { title: 'Sprint review', startMinutes: 840, endMinutes: 900, color: '#EC4899', isAllDay: false },
      ],
    },
    {
      dayNumber: 10,
      dayName: 'Tue',
      eventCount: 1,
      isWeekend: false,
      events: [{ title: 'Product demo', startMinutes: 600, endMinutes: 720, color: '#F59E0B', isAllDay: false }],
    },
    {
      dayNumber: 11,
      dayName: 'Wed',
      eventCount: 4,
      isWeekend: false,
      events: [
        { title: 'Standup', startMinutes: 540, endMinutes: 570, color: '#6366F1', isAllDay: false },
        { title: '1:1 Maria', startMinutes: 600, endMinutes: 660, color: '#14B8A6', isAllDay: false },
        { title: 'Retro', startMinutes: 780, endMinutes: 840, color: '#EF4444', isAllDay: false },
        { title: 'Planning', startMinutes: 900, endMinutes: 1020, color: '#8B5CF6', isAllDay: false },
      ],
    },
    {
      dayNumber: 12,
      dayName: 'Thu',
      eventCount: 2,
      isWeekend: false,
      events: [
        { title: 'Workshop', startMinutes: 540, endMinutes: 660, color: '#EC4899', isAllDay: false },
        { title: 'Team lunch', startMinutes: 720, endMinutes: 780, color: '#6366F1', isAllDay: false },
      ],
    },
    { dayNumber: 13, dayName: 'Fri', eventCount: 0, isWeekend: false, events: [] },
    {
      dayNumber: 14,
      dayName: 'Sat',
      eventCount: 2,
      isWeekend: true,
      events: [
        { title: 'Gym', startMinutes: 600, endMinutes: 720, color: '#14B8A6', isAllDay: false },
        { title: 'Pi Day 🥧', startMinutes: 0, endMinutes: 1440, color: '#EC4899', isAllDay: true },
      ],
    },
    { dayNumber: 15, dayName: 'Sun', eventCount: 0, isWeekend: true, events: [] },
  ],
  theme: THEME_LIGHT,
  locale: 'en',
};

const weekHtml = weeklyOverviewTemplate.render(weekData);
await renderToFile(weekHtml, '/tmp/weekly-overview.png');

// --- Event Card ---
const cardData: EventCardData = {
  title: 'Design Review: Q1 Roadmap',
  dateFormatted: 'Saturday, March 14, 2026',
  timeFormatted: '10:00 – 11:00',
  duration: '1h',
  location: 'Room 42, Building A',
  description:
    'Review the Q1 product roadmap, discuss priorities for the next sprint, and align on design system updates. Please bring your laptop with the latest Figma file open.',
  attendees: ['Alex', 'Maria', 'Ivan', 'Daria'],
  attendeeOverflow: 3,
  conferenceLink: 'meet.google.com/abc-defg-hij',
  calendarName: 'Work Calendar',
  calendarColor: '#6366F1',
  isAllDay: false,
  theme: THEME_LIGHT,
  locale: 'en',
};

const cardHtml = eventCardTemplate.render(cardData);
await renderToFile(cardHtml, '/tmp/event-card.png');

await pool.shutdown();
console.log('\nAll renders complete! Check /tmp/*.png');
