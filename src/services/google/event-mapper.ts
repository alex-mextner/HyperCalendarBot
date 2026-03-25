import { syncLogger } from '../../utils/logger.ts';

interface LocalEventForGoogle {
  id: number;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  all_day: number; // 0 | 1
  timezone: string;
  location: string | null;
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
}

interface LocalEventFromGoogle {
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
    location: local.location ?? undefined,
    extendedProperties: {
      private: {
        hypercalendarbot_event_id: String(local.id),
        hypercalendarbot_version: String(local.sync_version),
      },
    },
  };

  if (local.all_day) {
    const startDate = local.start_at.split('T')[0];
    const rawEndDate = (local.end_at ?? local.start_at).split('T')[0];
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
    event.recurrence = [local.recurrence_rule];
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

  return {
    user_id: userId,
    title: gEvent.summary ?? 'Untitled',
    description: gEvent.description ?? null,
    start_at: isAllDay ? (gEvent.start?.date ?? '') : (gEvent.start?.dateTime ?? ''),
    end_at: isAllDay ? (gEvent.end?.date ?? null) : (gEvent.end?.dateTime ?? null),
    all_day: isAllDay,
    timezone: gEvent.start?.timeZone ?? 'UTC',
    location: gEvent.location ?? null,
    recurrence_rule: gEvent.recurrence?.[0] ?? null,
    google_calendar_id: googleCalendarId,
    google_event_id: gEvent.id ?? '',
    google_etag: gEvent.etag ?? null,
    is_cancelled: gEvent.status === 'cancelled',
  };
}
