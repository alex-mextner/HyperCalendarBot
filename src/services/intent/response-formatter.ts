import { z } from 'zod';
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
  const trimmed = output.trim();
  // Fast path: not JSON-like — return as-is (most tool outputs are human-readable strings)
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length < 3) {
    return output;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return output;
  }
  // JSON object — try to extract a human-readable field
  const result = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (result.success) {
    for (const key of ['output', 'message', 'text', 'result']) {
      const val = result.data[key];
      if (typeof val === 'string') return val;
    }
  }
  // JSON but no extractable text — return raw as last resort
  return output;
}

function formatEventsList(output: string, timezone: string, language: string): string {
  const events = z
    .array(z.object({ title: z.string(), start_at: z.string(), end_at: z.string().optional() }))
    .parse(JSON.parse(output));
  if (events.length === 0) {
    return language === 'ru' ? 'Нет событий' : 'No events';
  }

  return events
    .map((e) => {
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
  const slots = z.array(z.object({ start: z.string(), end: z.string() })).parse(JSON.parse(output));
  if (slots.length === 0) {
    return '';
  }

  return slots
    .map((slot) => {
      const startTime = formatTime(slot.start, timezone);
      const endTime = formatTime(slot.end, timezone);
      return `${startTime}–${endTime}`;
    })
    .join('\n');
}

function formatSearchResults(output: string, timezone: string, _language: string): string {
  const events = z.array(z.object({ title: z.string(), start_at: z.string() })).parse(JSON.parse(output));
  if (events.length === 0) {
    return '';
  }

  return events
    .map((e, index) => {
      const time = formatTime(e.start_at, timezone);
      return `${index + 1}. ${time}  ${e.title}`;
    })
    .join('\n');
}

function formatHolidays(output: string, _language: string): string {
  const holidays = z.array(z.object({ name: z.string(), date: z.string() })).parse(JSON.parse(output));
  if (holidays.length === 0) {
    return '';
  }

  return holidays.map((h) => `${h.name} (${h.date})`).join('\n');
}

function formatSettings(output: string, _language: string): string {
  const result = z.record(z.string(), z.unknown()).safeParse(JSON.parse(output));
  if (!result.success) {
    return '';
  }

  return Object.entries(result.data)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}
