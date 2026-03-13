import { describe, expect, test } from "bun:test";
import { THEME_DARK, THEME_LIGHT, getTheme } from "../../../src/worker/templates/themes.ts";

describe("themes", () => {
  test("THEME_LIGHT has all required fields", () => {
    expect(THEME_LIGHT.name).toBe("light");
    expect(THEME_LIGHT.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(THEME_LIGHT.eventColors.length).toBeGreaterThanOrEqual(4);
  });

  test("THEME_DARK has all required fields", () => {
    expect(THEME_DARK.name).toBe("dark");
    expect(THEME_DARK.bg).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(THEME_DARK.eventColors.length).toBeGreaterThanOrEqual(4);
  });

  test("getTheme returns light by default", () => {
    expect(getTheme()).toBe(THEME_LIGHT);
    expect(getTheme("light")).toBe(THEME_LIGHT);
  });

  test("getTheme returns dark", () => {
    expect(getTheme("dark")).toBe(THEME_DARK);
  });

  test("getTheme returns light for unknown theme", () => {
    expect(getTheme("neon")).toBe(THEME_LIGHT);
  });
});
