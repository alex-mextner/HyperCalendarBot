// Intentionally kept: iCalendar export generator for future /export command.
// Not currently wired up — /export command has not been implemented yet.
// src/services/ics/generator.ts
import type { CalendarEvent } from '../../database/types.ts';

/**
 * Generate ICS (iCalendar) string from events
 */
export function generateIcs(events: CalendarEvent[]): string {
  const vevents = events.map(eventToVevent).join('\n');
  return `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//HyperCalendarBot//EN\nCALSCALE:GREGORIAN\n${vevents}\nEND:VCALENDAR`;
}

function eventToVevent(event: CalendarEvent): string {
  const lines: string[] = ['BEGIN:VEVENT'];
  // Include start_at in UID to make expanded recurring occurrences unique
  const uidDate = event.start_at.replace(/[-:T.Z]/g, '').slice(0, 14);
  lines.push(`UID:${event.id}-${uidDate}@hypercalendarbot`);
  lines.push(`DTSTART:${isoToIcsDate(event.start_at)}`);
  if (event.end_at) lines.push(`DTEND:${isoToIcsDate(event.end_at)}`);
  lines.push(`SUMMARY:${escapeIcs(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  if (event.recurrence_rule) lines.push(`RRULE:${event.recurrence_rule}`);
  lines.push(`CREATED:${isoToIcsDate(event.created_at)}`);
  lines.push('END:VEVENT');
  return lines.join('\n');
}

function isoToIcsDate(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}
