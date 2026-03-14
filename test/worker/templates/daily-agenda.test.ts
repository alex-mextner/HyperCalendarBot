import { describe, expect, test } from "bun:test";
import { dailyAgendaTemplate } from "../../../src/worker/templates/daily-agenda.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { DailyAgendaData } from "../../../src/worker/templates/types.ts";

function makeData(overrides: Partial<DailyAgendaData> = {}): DailyAgendaData {
  return {
    date: "2026-03-11",
    dayOfWeek: "Wednesday",
    dateFormatted: "March 11, 2026",
    eventCount: 0,
    allDayEvents: [],
    timedEvents: [],
    theme: THEME_LIGHT,
    locale: "en",
    ...overrides,
  };
}

describe("dailyAgendaTemplate", () => {
  test("renders valid HTML", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<div id="__root">');
    expect(html).toContain("</html>");
  });

  test("renders date in header", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("March 11, 2026");
  });

  test("renders day of week and event count", () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 3 }));
    expect(html).toContain("Wednesday");
    expect(html).toContain("3 events");
  });

  test("Russian event count", () => {
    const html = dailyAgendaTemplate.render(makeData({ eventCount: 5, locale: "ru" }));
    expect(html).toContain("5 событий");
  });

  test("renders relative day badge", () => {
    const html = dailyAgendaTemplate.render(makeData({ relativeDay: "Today" }));
    expect(html).toContain("Today");
    expect(html).toContain("header__badge");
  });

  test("empty state when no events", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("No events");
  });

  test("Russian empty state", () => {
    const html = dailyAgendaTemplate.render(makeData({ locale: "ru" }));
    expect(html).toContain("Нет событий");
  });

  test("renders timed events with time and color", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Standup", startMinutes: 540, endMinutes: 570,
        calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("Standup");
    expect(html).toContain("09:00");
    expect(html).toContain("09:30");
    expect(html).toContain("#6366F1");
  });

  test("renders all-day events", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      allDayEvents: [{
        id: 2, title: "Company Holiday", startMinutes: 0, endMinutes: 1440,
        calendarColor: "#EC4899", isAllDay: true,
      }],
    }));
    expect(html).toContain("Company Holiday");
    expect(html).toContain("allday");
  });

  test("renders current time indicator", () => {
    const html = dailyAgendaTemplate.render(makeData({
      currentTimeMinutes: 615,
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Meeting", startMinutes: 540, endMinutes: 660,
        calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("now-line");
  });

  test("renders holiday badge", () => {
    const html = dailyAgendaTemplate.render(makeData({ isHoliday: true, holidayName: "New Year" }));
    expect(html).toContain("New Year");
    expect(html).toContain("holiday-badge");
  });

  test("escapes HTML in titles", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: '<script>alert("x")</script>', startMinutes: 540,
        endMinutes: 600, calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders event location", () => {
    const html = dailyAgendaTemplate.render(makeData({
      eventCount: 1,
      timedEvents: [{
        id: 1, title: "Meeting", startMinutes: 540, endMinutes: 600,
        location: "Room 42", calendarColor: "#6366F1", isAllDay: false,
      }],
    }));
    expect(html).toContain("Room 42");
  });

  test("renders footer", () => {
    const html = dailyAgendaTemplate.render(makeData());
    expect(html).toContain("HyperCalendar");
  });
});
