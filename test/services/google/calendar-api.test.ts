// Exercises the real Google client request serialization with an offline OAuth transport.
import { expect, test } from 'bun:test';
import { OAuth2Client } from 'google-auth-library';
import { GoogleCalendarApi } from '../../../src/services/google/calendar-api.ts';

function fixture() {
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: 'offline-test-token', expiry_date: Date.now() + 3600000 });
  const requests: { url: URL; method: string; body: unknown; authorization: string | null }[] = [];
  let response: object = {};
  let status = 200;
  auth.transporter.defaults.retry = false;
  auth.transporter.defaults.fetchImplementation = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: new URL(String(input)),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
    },
    { preconnect() {} },
  );
  return {
    api: new GoogleCalendarApi(auth),
    requests,
    respond(body: object, code = 200) {
      response = body;
      status = code;
    },
  };
}

test('calendar listing maps explicit fields and missing defaults', async () => {
  const f = fixture();
  f.respond({
    items: [
      { id: 'primary', summary: 'Work', backgroundColor: '#fff', primary: true, accessRole: 'owner' },
      { id: 'empty' },
    ],
  });
  expect(await f.api.listCalendars()).toEqual([
    { google_calendar_id: 'primary', calendar_name: 'Work', color: '#fff', is_primary: true, access_role: 'owner' },
    { google_calendar_id: 'empty', calendar_name: 'Untitled', color: null, is_primary: false, access_role: 'reader' },
  ]);
  expect(f.requests[0]?.url.pathname).toBe('/calendar/v3/users/me/calendarList');
  expect(f.requests[0]?.authorization).toBe('Bearer offline-test-token');
  f.respond({});
  expect(await f.api.listCalendars()).toEqual([]);
});

test('event pagination preserves filters, tokens and defaults', async () => {
  const f = fixture();
  f.respond({ items: [{ id: 'e' }], nextSyncToken: 'next-sync', nextPageToken: 'next-page' });
  expect(
    await f.api.listEvents('cal@example.com', {
      syncToken: 'sync',
      pageToken: 'page',
      timeMin: '2026-01-01T00:00:00Z',
      maxResults: 17,
    }),
  ).toEqual({ events: [{ id: 'e' }], nextSyncToken: 'next-sync', nextPageToken: 'next-page' });
  expect(Object.fromEntries(f.requests[0]!.url.searchParams)).toEqual({
    singleEvents: 'false',
    maxResults: '17',
    syncToken: 'sync',
    pageToken: 'page',
    timeMin: '2026-01-01T00:00:00Z',
  });
  f.respond({});
  expect(await f.api.listEvents('primary', {})).toEqual({ events: [], nextSyncToken: null, nextPageToken: null });
  expect(f.requests[1]?.url.searchParams.get('maxResults')).toBe('250');
});

test('event writes and reads serialize calendar, event id and request body', async () => {
  const f = fixture();
  const event = { summary: 'Meeting', start: { date: '2026-09-13' }, end: { date: '2026-09-14' } };
  f.respond({ ...event, id: 'created' });
  expect(await f.api.insertEvent('primary', event)).toEqual({ ...event, id: 'created' });
  expect(f.requests[0]).toMatchObject({ method: 'POST', body: event });
  expect(f.requests[0]?.url.pathname).toBe('/calendar/v3/calendars/primary/events');
  expect(await f.api.updateEvent('primary', 'created', event)).toMatchObject({ id: 'created' });
  expect(f.requests[1]).toMatchObject({ method: 'PUT', body: event });
  expect(await f.api.getEvent('primary', 'created')).toMatchObject({ id: 'created' });
  expect(f.requests[2]?.method).toBe('GET');
  await f.api.deleteEvent('primary', 'created');
  expect(f.requests[3]?.method).toBe('DELETE');
  for (const request of f.requests.slice(1))
    expect(request.url.pathname).toBe('/calendar/v3/calendars/primary/events/created');
});

test('watch requests preserve token and convert expiration; stop tolerates expired channels', async () => {
  const f = fixture();
  const expiration = Date.parse('2026-09-20T00:00:00Z');
  f.respond({ resourceId: 'resource', expiration: String(expiration) });
  expect(await f.api.watchEvents('primary', 'channel', 'https://offline.invalid/hook', expiration, 'token')).toEqual({
    resourceId: 'resource',
    expiration: '2026-09-20T00:00:00.000Z',
    token: 'token',
  });
  expect(f.requests[0]?.body).toEqual({
    id: 'channel',
    type: 'web_hook',
    address: 'https://offline.invalid/hook',
    expiration: String(expiration),
    token: 'token',
  });
  await f.api.stopChannel('channel', 'resource');
  expect(f.requests[1]?.body).toEqual({ id: 'channel', resourceId: 'resource' });
  expect(f.requests[1]?.url.pathname).toBe('/calendar/v3/channels/stop');
  f.respond({ error: { message: 'expired' } }, 404);
  await expect(f.api.stopChannel('channel', 'resource')).resolves.toBeUndefined();
});

test('API errors propagate for reads and writes; invalid watch expiration is rejected', async () => {
  const f = fixture();
  f.respond({ error: { message: 'permission denied' } }, 403);
  for (const call of [
    () => f.api.listCalendars(),
    () => f.api.listEvents('primary', {}),
    () => f.api.insertEvent('primary', {}),
    () => f.api.updateEvent('primary', 'e', {}),
    () => f.api.getEvent('primary', 'e'),
    () => f.api.deleteEvent('primary', 'e'),
    () => f.api.watchEvents('primary', 'c', 'https://offline.invalid', 1, 't'),
  ])
    await expect(call()).rejects.toThrow('permission denied');
  f.respond({ resourceId: 'r', expiration: 'invalid' });
  await expect(f.api.watchEvents('primary', 'c', 'https://offline.invalid', 1, 't')).rejects.toThrow();
});
