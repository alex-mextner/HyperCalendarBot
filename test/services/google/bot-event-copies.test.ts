// #875: the lookup of a bot event's Google copies reads every page. Google may answer a filtered page
// with fewer items than asked, even none, while more follow; stopping early would make an existing copy
// look absent and the push would insert a second one.
import { describe, expect, mock, test } from 'bun:test';
import {
  type BotEventCopiesQuery,
  type EventListPage,
  listBotEventCopies,
} from '../../../src/services/google/bot-event-copies.ts';
import { BOT_EVENT_MARKER } from '../../../src/services/google/event-mapper.ts';

/** A page source answering `pages` by the page token it is asked for ('' for the first page). */
function pagesAnswering(pages: { [pageToken: string]: EventListPage }) {
  return mock(
    (query: BotEventCopiesQuery): Promise<EventListPage> => Promise.resolve(pages[query.pageToken ?? ''] ?? {}),
  );
}

describe('listBotEventCopies (#875)', () => {
  test('follows the page token past an empty page and returns the copies of every page', async () => {
    const listPage = pagesAnswering({
      '': { items: [], nextPageToken: 'page-2' },
      'page-2': { items: [{ id: 'g-1' }], nextPageToken: 'page-3' },
      'page-3': { items: [{ id: 'g-2' }, { id: 'g-3' }] },
    });

    const copies = await listBotEventCopies(listPage, 'primary', 42);

    expect(copies.map((copy) => copy.id)).toEqual(['g-1', 'g-2', 'g-3']);
    expect(listPage.mock.calls.map(([query]) => query.pageToken)).toEqual([undefined, 'page-2', 'page-3']);
  });

  test('asks Google for the marker of that bot event in that calendar only', async () => {
    const listPage = pagesAnswering({ '': { items: null } });

    const copies = await listBotEventCopies(listPage, 'work@example.com', 42);

    expect(copies).toEqual([]);
    expect(listPage).toHaveBeenCalledTimes(1);
    const [query] = listPage.mock.calls[0]!;
    expect(query.calendarId).toBe('work@example.com');
    expect(query.privateExtendedProperty).toEqual([`${BOT_EVENT_MARKER}=42`]);
  });
});
