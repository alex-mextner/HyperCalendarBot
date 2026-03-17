import { formatTime } from '../../utils/date.ts';

/**
 * Format tool output into a user-friendly response string.
 * @param format - format type name
 * @param toolOutput - raw tool output string (often JSON)
 * @param timezone - user timezone (IANA)
 * @param language - user language ('en' or 'ru')
 * @returns formatted string for display
 */
export function formatResponse(format: string, toolOutput: string, timezone: string, language: string): string {
  try {
    switch (format) {
      case 'text':
        return formatText(toolOutput);
      case 'events_list':
        return formatEventsList(toolOutput, timezone, language);
      case 'free_slots':
        return formatFreeSlots(toolOutput, timezone, language);
      case 'search_results':
        return formatSearchResults(toolOutput, timezone, language);
      case 'holidays':
        return formatHolidays(toolOutput, language);
      case 'settings':
        return formatSettings(toolOutput, language);
      default:
        return formatText(toolOutput);
    }
  } catch {
    // On any error (JSON parse, etc.), fall back to raw text
    return toolOutput;
  }
}

function formatText(output: string): string {
  return output;
}

function formatEventsList(output: string, timezone: string, language: string): string {
  const events = JSON.parse(output);
  if (!Array.isArray(events) || events.length === 0) {
    return language === 'ru' ? 'Нет событий' : 'No events';
  }

  return events
    .map((e: { title: string; start_at: string; end_at?: string }) => {
      const startTime = formatTime(e.start_at, timezone);
      let timeStr = startTime;

      if (e.end_at) {
        const endTime = formatTime(e.end_at, timezone);
        timeStr = `${startTime}–${endTime}`;
      }

      return `${timeStr}  ${e.title}`;
    })
    .join('\n');
}

function formatFreeSlots(output: string, timezone: string, _language: string): string {
  const slots = JSON.parse(output);
  if (!Array.isArray(slots) || slots.length === 0) {
    return '';
  }

  return slots
    .map((slot: { start: string; end: string }) => {
      const startTime = formatTime(slot.start, timezone);
      const endTime = formatTime(slot.end, timezone);
      return `${startTime}–${endTime}`;
    })
    .join('\n');
}

function formatSearchResults(output: string, timezone: string, _language: string): string {
  const events = JSON.parse(output);
  if (!Array.isArray(events) || events.length === 0) {
    return '';
  }

  return events
    .map(
      (
        e: {
          title: string;
          start_at: string;
        },
        index: number,
      ) => {
        const time = formatTime(e.start_at, timezone);
        return `${index + 1}. ${time}  ${e.title}`;
      },
    )
    .join('\n');
}

function formatHolidays(output: string, _language: string): string {
  const holidays = JSON.parse(output);
  if (!Array.isArray(holidays) || holidays.length === 0) {
    return '';
  }

  return holidays.map((h: { name: string; date: string }) => `${h.name} (${h.date})`).join('\n');
}

function formatSettings(output: string, _language: string): string {
  const settings = JSON.parse(output);
  if (typeof settings !== 'object' || settings === null) {
    return '';
  }

  return Object.entries(settings)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}
