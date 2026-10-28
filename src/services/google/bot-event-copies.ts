// src/services/google/bot-event-copies.ts
// The search for the Google copies of one bot event (#875), kept apart from the API class so it can be
// exercised without a Calendar client.
import type { calendar_v3 } from 'googleapis';
import { BOT_EVENT_MARKER } from './event-mapper.ts';

/** The one page of `events.list` the lookup needs: its items and the token of the next page. */
export interface EventListPage {
  items?: calendar_v3.Schema$Event[] | null;
  nextPageToken?: string | null;
}

/** The parameters of `events.list` the lookup sends. */
export interface BotEventCopiesQuery {
  calendarId: string;
  privateExtendedProperty: string[];
  pageToken?: string;
}

/**
 * Every live copy of one bot event in a calendar: the events whose private extended property
 * `hypercalendarbot_event_id` equals `botEventId` (deleted events are not listed by default).
 * Google filters on the server and may answer a page with fewer items than asked, even none, while
 * more follow, so every page is read; stopping early would make an existing copy look absent and
 * the caller would insert a second one.
 */
export async function listBotEventCopies(
  listPage: (query: BotEventCopiesQuery) => Promise<EventListPage>,
  calendarId: string,
  botEventId: number,
): Promise<calendar_v3.Schema$Event[]> {
  const copies: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listPage({
      calendarId,
      privateExtendedProperty: [`${BOT_EVENT_MARKER}=${botEventId}`],
      pageToken,
    });
    copies.push(...(page.items ?? []));
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return copies;
}
