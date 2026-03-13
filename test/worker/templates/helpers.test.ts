import { describe, expect, test } from "bun:test";
import {
  computeEventColumns,
  escapeHtml,
  formatDuration,
  formatTime,
} from "../../../src/worker/templates/helpers.ts";

describe("escapeHtml", () => {
  test("escapes special characters", () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  test("escapes ampersand", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B");
  });

  test("passes through safe strings", () => {
    expect(escapeHtml("Hello World")).toBe("Hello World");
  });
});

describe("formatTime", () => {
  test("midnight", () => expect(formatTime(0)).toBe("00:00"));
  test("morning", () => expect(formatTime(570)).toBe("09:30"));
  test("afternoon", () => expect(formatTime(845)).toBe("14:05"));
  test("end of day", () => expect(formatTime(1439)).toBe("23:59"));
});

describe("formatDuration", () => {
  test("minutes only", () => expect(formatDuration(30)).toBe("30min"));
  test("hours only", () => expect(formatDuration(120)).toBe("2h"));
  test("hours and minutes", () => expect(formatDuration(90)).toBe("1h 30min"));
  test("zero", () => expect(formatDuration(0)).toBe(""));
});

describe("computeEventColumns", () => {
  test("single event → column 0, totalColumns 1", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
    ]);
    expect(result).toEqual([{ column: 0, totalColumns: 1 }]);
  });

  test("non-overlapping → all column 0", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 660, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 1 },
      { column: 0, totalColumns: 1 },
    ]);
  });

  test("two overlapping → columns 0 and 1", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 660 },
      { startMinutes: 600, endMinutes: 720 },
    ]);
    expect(result).toEqual([
      { column: 0, totalColumns: 2 },
      { column: 1, totalColumns: 2 },
    ]);
  });

  test("three overlapping → columns 0, 1, 2", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 720 },
      { startMinutes: 600, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 750 },
    ]);
    expect(result[0].column).toBe(0);
    expect(result[1].column).toBe(1);
    expect(result[2].column).toBe(2);
    for (const r of result) expect(r.totalColumns).toBe(3);
  });

  test("partial overlap chain: A↔B, B↔C, not A↔C", () => {
    const result = computeEventColumns([
      { startMinutes: 540, endMinutes: 600 },
      { startMinutes: 570, endMinutes: 660 },
      { startMinutes: 630, endMinutes: 720 },
    ]);
    expect(result[0]).toEqual({ column: 0, totalColumns: 2 });
    expect(result[1]).toEqual({ column: 1, totalColumns: 2 });
    expect(result[2]).toEqual({ column: 0, totalColumns: 2 });
  });

  test("empty → empty", () => {
    expect(computeEventColumns([])).toEqual([]);
  });
});
