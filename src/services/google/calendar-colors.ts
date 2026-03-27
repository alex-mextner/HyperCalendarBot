// src/services/google/calendar-colors.ts

const GOOGLE_CALENDAR_COLORS: { [hex: string]: string } = {
  '#d50000': '🔴', // Tomato
  '#e67c73': '🩷', // Flamingo
  '#f4511e': '🟠', // Tangerine
  '#f6bf26': '🟡', // Banana
  '#33b679': '🟢', // Sage
  '#0f9d58': '🟩', // Basil
  '#039be5': '🔵', // Peacock
  '#3f51b5': '💙', // Blueberry
  '#7986cb': '🟣', // Lavender
  '#8e24aa': '💜', // Grape
  '#616161': '⚫', // Graphite
};

/** Map a Google Calendar hex color to an emoji dot, or empty string if unknown/null. */
export function googleCalendarColorEmoji(color: string | null | undefined): string {
  if (!color) return '';
  return GOOGLE_CALENDAR_COLORS[color.toLowerCase()] ?? '';
}
