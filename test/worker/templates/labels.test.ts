import { describe, expect, test } from "bun:test";
import { getLabels, pluralizeEvents } from "../../../src/worker/templates/labels.ts";

describe("getLabels", () => {
  test("Russian labels", () => {
    const l = getLabels("ru");
    expect(l.today).toBe("Сегодня");
    expect(l.noEvents).toBe("Нет событий");
    expect(l.allDay).toBe("Весь день");
  });

  test("English labels", () => {
    const l = getLabels("en");
    expect(l.today).toBe("Today");
    expect(l.allDay).toBe("All day");
  });

  test("weekDaysShort has 7 entries", () => {
    expect(getLabels("ru").weekDaysShort).toHaveLength(7);
    expect(getLabels("en").weekDaysShort).toHaveLength(7);
  });

  test("monthNames has 12 entries", () => {
    expect(getLabels("ru").monthNames).toHaveLength(12);
    expect(getLabels("en").monthNames).toHaveLength(12);
  });
});

describe("pluralizeEvents", () => {
  test("Russian: 1 событие", () => {
    expect(pluralizeEvents(1, "ru")).toBe("событие");
  });

  test("Russian: 2-4 события", () => {
    expect(pluralizeEvents(2, "ru")).toBe("события");
    expect(pluralizeEvents(3, "ru")).toBe("события");
    expect(pluralizeEvents(4, "ru")).toBe("события");
  });

  test("Russian: 5-20 событий", () => {
    expect(pluralizeEvents(5, "ru")).toBe("событий");
    expect(pluralizeEvents(11, "ru")).toBe("событий");
    expect(pluralizeEvents(20, "ru")).toBe("событий");
  });

  test("Russian: 21 событие, 22 события", () => {
    expect(pluralizeEvents(21, "ru")).toBe("событие");
    expect(pluralizeEvents(22, "ru")).toBe("события");
  });

  test("English: singular/plural", () => {
    expect(pluralizeEvents(1, "en")).toBe("event");
    expect(pluralizeEvents(0, "en")).toBe("events");
    expect(pluralizeEvents(5, "en")).toBe("events");
  });
});
