import type { CalendarEvent } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import { parseRecurrenceBlock, RecurrenceUnsupportedError } from '../event/recurrence-block.ts';
import { formatLocationPlain } from '../location/format-location.ts';

interface LocalEventForGoogle
  extends Pick<CalendarEvent, 'location' | 'resolved_address' | 'venue_name' | 'location_verified'> {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  recurrence_rule: string | null;
  reminder_overrides: string | null; // JSON "[5, 30]"
  sync_version: number;
}

interface GoogleEventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEventReminder {
  method: string;
  minutes: number;
}

export interface GoogleEvent {
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  recurrence?: string[];
  reminders?: {
    useDefault: boolean;
    overrides?: GoogleEventReminder[];
  };
  extendedProperties?: {
    private?: Record<string, string>;
  };
  id?: string | null;
  etag?: string | null;
  status?: string | null;
  updated?: string | null;
  recurringEventId?: string | null;
}

export interface LocalEventFromGoogle {
  user_id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: boolean;
  timezone: string;
  location: string | null;
  recurrence_rule: string | null;
  google_calendar_id: string;
  google_event_id: string;
  google_etag: string | null;
  is_cancelled: boolean;
}

export function localToGoogle(local: LocalEventForGoogle): GoogleEvent {
  const event: GoogleEvent = {
    summary: local.title,
    description: local.description ?? undefined,
    // Free-form text Google geocodes: the verified place, else the typed text. Pull never reads it
    // back into a bot event: copies carrying hypercalendarbot_event_id are skipped.
    location: formatLocationPlain(local) || undefined,
    extendedProperties: {
      private: {
        hypercalendarbot_event_id: String(local.id),
        hypercalendarbot_version: String(local.sync_version),
      },
    },
  };

  if (local.all_day) {
    const startDate = local.start_at.split('T')[0]!;
    const rawEndDate = (local.end_at ?? local.start_at).split('T')[0]!;
    // Google Calendar requires end.date > start.date for all-day events (exclusive end).
    // When end_at is absent or points to the same calendar day as start_at, advance by one day.
    const endDate =
      rawEndDate <= startDate
        ? new Date(new Date(`${startDate}T00:00:00Z`).getTime() + 86_400_000).toISOString().split('T')[0]
        : rawEndDate;
    event.start = { date: startDate };
    event.end = { date: endDate };
  } else {
    event.start = { dateTime: local.start_at, timeZone: local.timezone };
    event.end = local.end_at
      ? { dateTime: local.end_at, timeZone: local.timezone }
      : { dateTime: local.start_at, timeZone: local.timezone };
  }

  if (local.recurrence_rule) {
    // Serialize the canonical prefixed block — a locally-created bare rule
    // ("FREQ=WEEKLY;...", no RRULE: prefix) must be normalized before Google will accept it as
    // a valid `recurrence` array entry; see spec §8. `GoogleCalendarApi.updateEvent` calls the
    // Calendar API's `events.update`, a full-resource replace — omitting `recurrence` entirely
    // would CLEAR an existing Google series, not merely fail to improve it. On an unsupported
    // rule, fall back to the pre-583 raw line split instead of dropping the field: Google sees
    // the same (possibly already-malformed) data it always did, not a newly destructive edit.
    try {
      const parsed = parseRecurrenceBlock(local.recurrence_rule, local.all_day ? 'date' : 'date-time');
      event.recurrence = parsed.lines;
    } catch (err) {
      syncLogger.warn(
        {
          err,
          eventId: local.id,
          reason: err instanceof RecurrenceUnsupportedError ? err.reason : undefined,
        },
        'recurrence_rule failed validation on Google export; pushing the raw line split instead of clearing the series',
      );
      event.recurrence = local.recurrence_rule.split('\n');
    }
  }

  if (local.reminder_overrides) {
    try {
      const minutes: number[] = JSON.parse(local.reminder_overrides);
      event.reminders = {
        useDefault: false,
        overrides: minutes.map((m) => ({ method: 'popup', minutes: m })),
      };
    } catch (err) {
      syncLogger.warn(
        { err, eventId: local.id, raw: local.reminder_overrides },
        'Failed to parse reminder_overrides, skipping',
      );
    }
  }

  return event;
}

export function googleToLocal(gEvent: GoogleEvent, userId: number, googleCalendarId: string): LocalEventFromGoogle {
  const isAllDay = !!gEvent.start?.date;

  let recurrenceRule: string | null = null;
  if (gEvent.recurrence && gEvent.recurrence.length > 0) {
    try {
      const parsed = parseRecurrenceBlock(gEvent.recurrence.join('\n'), isAllDay ? 'date' : 'date-time');
      recurrenceRule = parsed.lines.join('\n');
    } catch (err) {
      // Store Google's lines verbatim (pre-583 behavior) instead of null: sync writes this value
      // over an existing local series, and null would silently turn it into a one-off and clear
      // the Google series on the next push. Expansion rejects/isolates the series explicitly.
      recurrenceRule = gEvent.recurrence.join('\n');
      syncLogger.warn(
        { err, googleEventId: gEvent.id, reason: err instanceof RecurrenceUnsupportedError ? err.reason : undefined },
        'Google recurrence failed validation; stored verbatim',
      );
    }
  }

  return {
    user_id: userId,
    title: gEvent.summary ?? 'Untitled',
    description: gEvent.description ?? null,
    start_at: isAllDay ? (gEvent.start?.date ?? '') : (gEvent.start?.dateTime ?? ''),
    end_at: isAllDay ? (gEvent.end?.date ?? null) : (gEvent.end?.dateTime ?? null),
    all_day: isAllDay,
    timezone: gEvent.start?.timeZone ?? 'UTC',
    location: gEvent.location ?? null,
    recurrence_rule: recurrenceRule,
    google_calendar_id: googleCalendarId,
    google_event_id: gEvent.id ?? '',
    google_etag: gEvent.etag ?? null,
    is_cancelled: gEvent.status === 'cancelled',
  };
}
