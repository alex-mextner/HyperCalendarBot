// How an event is shown to the assistant: the text parts of a tool result (times, location, weather)
// and the structured EventSummary returned as `data`. Pure formatting, shared by every event handler.
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import type { Lang } from '../../../../config/constants.ts';
import { t } from '../../../../config/constants.ts';
import type { CalendarEvent, EventOccurrence } from '../../../../database/types.ts';
import { allDayDates, formatLocalEventSpan } from '../../../../utils/date.ts';
import type { EventSummary } from '../../../intent/variable-resolver.ts';
import { formatLocationPlain } from '../../../location/format-location.ts';
import { formatEventWeatherLine } from '../../../weather/format.ts';
import { dayOfStart } from '../../day-reference-guard.ts';
import type { AgentContext } from '../../types.ts';

/** Fetch event-time weather and return a formatted suffix like `, weather: ☀️ 15°C, clear sky`. */
export async function weatherSuffix(ctx: AgentContext, startAt: string, allDay: boolean): Promise<string> {
  if (!ctx.weatherService) return '';
  const lang = (ctx.user.language ?? 'en') as Lang;
  try {
    const forecast = await ctx.weatherService.getForecastAt(ctx.user.timezone, new Date(startAt).getTime(), lang, {
      allDay,
    });
    if (!forecast) return '';
    return `, ${t(lang).weather.eventForecast(formatEventWeatherLine(lang, forecast))}`;
  } catch {
    // Weather is non-critical — API failure should not break tool output
    return '';
  }
}

/**
 * Event time for the assistant: the user's wall clock first, so it is never tempted to present a
 * UTC clock time as local, then the stored instants explicitly labelled as UTC. All-day values are
 * floating calendar dates, labelled as dates (with an explicitly exclusive end), not as UTC instants.
 */
export function timeParts(start: string, end: string | null | undefined, allDay: boolean, timezone: string): string[] {
  const endIso = end ?? null;
  const parts = [`local: ${formatLocalEventSpan(start, endIso, allDay, timezone)}`];
  if (allDay) {
    const { first, endExclusive } = allDayDates(start, endIso, timezone);
    parts.push(`start_date: ${first}`);
    if (endExclusive) parts.push(`end_date_exclusive: ${endExclusive}`);
    return parts;
  }
  parts.push(`start_utc: ${new Date(start).toISOString()}`);
  if (endIso) parts.push(`end_utc: ${new Date(endIso).toISOString()}`);
  return parts;
}

/**
 * Location for the assistant: the typed text plus the verified place it resolved to (also a place a
 * pin confirmed on an event with no typed text), so the assistant can say which venue was chosen,
 * or a note that the location is not verified yet. Empty when the event has no location at all.
 */
export function locationParts(
  e: Pick<CalendarEvent, 'location' | 'resolved_address' | 'venue_name' | 'location_verified'>,
): string[] {
  const place = formatLocationPlain(e);
  if (e.location_verified === 1 && place) {
    const verified = `verified place: ${place}`;
    return [e.location ? `location: ${e.location}, ${verified}` : verified];
  }
  return e.location ? [`location: ${e.location} (not verified)`] : [];
}

export function occurrenceToSummary(occ: EventOccurrence, timezone: string): EventSummary {
  const d = new TZDate(new Date(occ.occurrence_start), timezone);
  const e = occ.event;
  const summary: EventSummary = {
    id: e.id,
    title: e.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(e.all_day),
  };
  if (!e.all_day) summary.time = format(d, 'HH:mm');
  if (occ.occurrence_end) summary.end_at = occ.occurrence_end;
  if (e.description) summary.description = e.description;
  if (e.location) summary.location = e.location;
  if (e.recurrence_rule) summary.recurrence_rule = e.recurrence_rule;
  return summary;
}

export function eventToSummary(event: CalendarEvent, timezone: string): EventSummary {
  const d = new TZDate(new Date(event.start_at), timezone);
  const summary: EventSummary = {
    id: event.id,
    title: event.title,
    date: format(d, 'yyyy-MM-dd'),
    all_day: Boolean(event.all_day),
  };
  if (!event.all_day) summary.time = format(d, 'HH:mm');
  if (event.end_at) summary.end_at = event.end_at;
  if (event.description) summary.description = event.description;
  if (event.location) summary.location = event.location;
  if (event.recurrence_rule) summary.recurrence_rule = event.recurrence_rule;
  return summary;
}

/**
 * Remember the event's local start day so a later day picture in this run can show it (#506).
 * A date-only (all-day) start is the day written, not UTC midnight shifted into the user's zone;
 * an unreadable start records nothing, which leaves a later picture on the requested day.
 */
export function recordChangedDay(ctx: AgentContext, event: CalendarEvent): void {
  const day = dayOfStart(event.start_at, ctx.user.timezone);
  if (!day) return;
  ctx.changedDays ??= new Set();
  ctx.changedDays.add(day);
}
