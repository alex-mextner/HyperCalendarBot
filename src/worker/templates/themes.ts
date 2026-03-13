import type { Theme } from "./types.ts";

export const THEME_LIGHT: Theme = {
  name: "light",
  bg: "#F8F9FA",
  cardBg: "#FFFFFF",
  textPrimary: "#1A1A2E",
  textSecondary: "#6B7280",
  accent: "#6366F1",
  border: "#E5E7EB",
  eventColors: ["#6366F1", "#EC4899", "#14B8A6", "#F59E0B", "#EF4444", "#8B5CF6"],
};

export const THEME_DARK: Theme = {
  name: "dark",
  bg: "#0F172A",
  cardBg: "#1E293B",
  textPrimary: "#F1F5F9",
  textSecondary: "#94A3B8",
  accent: "#818CF8",
  border: "#334155",
  eventColors: ["#818CF8", "#F472B6", "#2DD4BF", "#FBBF24", "#FB7185", "#A78BFA"],
};

const themes: Record<string, Theme> = { light: THEME_LIGHT, dark: THEME_DARK };

export function getTheme(name?: string): Theme {
  return themes[name ?? "light"] ?? THEME_LIGHT;
}
