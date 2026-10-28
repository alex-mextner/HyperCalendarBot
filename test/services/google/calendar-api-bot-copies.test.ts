// #875: the lookup of a bot event's Google copies reads every page. Google may answer a filtered page
// with fewer items than asked, even none, while more follow; stopping early would make an existing copy
// look absent and the push would insert a second one.
import { describe, expect, mock, test } from 'bun:test';
import { OAuth2Client } from 'google-auth-library';
import type { calendar_v3 } from 'googleapis';
import { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';
import { BOT_EVENT_MARKER } from '../../../src/services/google/event-mapper.ts';

interface ListParams {
  calendarId: string;
  privateExtendedProperty: string[];
  pageToken?: string;
}

interface ListAnswer {
  data: { items?: calendar_v3.Schema$Event[]; nextPageToken?: string };
}

/** A GoogleCalendarApi whose Calendar client answers `pages` in order, by the page token it is asked for. */
function apiAnswering(pages: Record<string, ListAnswer['data']>) {
  const list = mock(
    (params: ListParams): Promise<ListAnswer> => Promise.resolve({ data: pages[params.pageToken ?? ''] ?? {} }),
  );
  const api = new GoogleCalendarApi(new OAuth2Client());
  Reflect.set(api, 'api', { events: { list } });
  return { api, list };
}

describe('GoogleCalendarApi.findBotEventCopies (#875)', () => {
  test('follows the page token past an empty page and returns the copies of every page', async () => {
    const { api, list } = apiAnswering({
      '': { items: [], nextPageToken: 'page-2' },
      'page-2': { items: [{ id: 'g-1' }], nextPageToken: 'page-3' },
      'page-3': { items: [{ id: 'g-2' }, { id: 'g-3' }] },
    });

    const copies = await api.findBotEventCopies('primary', 42);

    expect(copies.map((copy) => copy.id)).toEqual(['g-1', 'g-2', 'g-3']);
    expect(list.mock.calls.map(([params]) => params.pageToken)).toEqual([undefined, 'page-2', 'page-3']);
  });

  test('asks Google for the marker of that bot event in that calendar only', async () => {
    const { api, list } = apiAnswering({ '': { items: [] } });

    const copies = await api.findBotEventCopies('work@example.com', 42);

    expect(copies).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    const [params] = list.mock.calls[0]!;
    expect(params.calendarId).toBe('work@example.com');
    expect(params.privateExtendedProperty).toEqual([`${BOT_EVENT_MARKER}=42`]);
  });
});
