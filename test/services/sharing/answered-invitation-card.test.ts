import { describe, expect, mock, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import type { CalendarEvent } from '../../../src/database/types.ts';
import { formatAnsweredInvitationCard } from '../../../src/services/sharing/answered-invitation-card.ts';
import type { EventForecast } from '../../../src/services/weather/types.ts';

const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

const event: CalendarEvent = {
  id: 642,
  user_id: 100,
  title: 'Meeting',
  description: null,
  category: null,
  start_at: startAt.toISOString(),
  end_at: new Date(startAt.getTime() + 60 * 60 * 1000).toISOString(),
  all_day: 0,
  timezone: 'Europe/Belgrade',
  location: 'Cafe',
  recurrence_rule: null,
  recurrence_end_at: null,
  parent_event_id: null,
  original_start_at: null,
  is_cancelled: 0,
  is_deleted: 0,
  reminder_overrides: null,
  google_event_id: null,
  google_calendar_id: null,
  google_etag: null,
  sync_status: 'local_only',
  sync_version: 1,
  owner_type: 'user',
  group_id: null,
  created_by: null,
  resolved_address: 'Cafe, Main St 1, Belgrade',
  latitude: 44.8,
  longitude: 20.46,
  google_maps_url: 'https://maps.google.com/?q=44.8,20.46',
  location_verified: 1,
  venue_name: null,
  last_synced_at: null,
  created_at: '',
  updated_at: '',
};

const forecast: EventForecast = {
  kind: 'hour',
  hour: { dt: 1_700_000_000, temp: 14, conditionCode: 500, description: 'light rain', windSpeed: 3 },
};

const viewer = { userId: 200, language: 'en' as const, timezone: 'Europe/Belgrade' };

describe('formatAnsweredInvitationCard', () => {
  test('accepted card: answer line, event detail with location, forecast at the event start', async () => {
    const getForecastAt = mock(() => Promise.resolve(forecast));

    const text = await formatAnsweredInvitationCard('accepted', event, viewer, { weatherService: { getForecastAt } });

    expect(text.startsWith(`${t('en').invitation_accepted}\n\n📌 <b>Meeting</b>`)).toBe(true);
    expect(text).toContain('Cafe, Main St 1, Belgrade');
    expect(text).toContain('14°C, light rain');
    expect(getForecastAt).toHaveBeenCalledWith('Europe/Belgrade', startAt.getTime(), 'en', { allDay: false });
  });

  test('maybe and declined cards carry no forecast', async () => {
    const getForecastAt = mock(() => Promise.resolve(forecast));

    const maybe = await formatAnsweredInvitationCard('maybe', event, viewer, { weatherService: { getForecastAt } });
    const declined = await formatAnsweredInvitationCard('declined', event, viewer, {
      weatherService: { getForecastAt },
    });

    expect(maybe.startsWith(`${t('en').invitation_maybe}\n\n`)).toBe(true);
    expect(declined.startsWith(`${t('en').invitation_declined}\n\n`)).toBe(true);
    expect(maybe).not.toContain('light rain');
    expect(getForecastAt).not.toHaveBeenCalled();
  });

  test('a failed forecast still renders the accepted card', async () => {
    const getForecastAt = mock(() => Promise.reject(new Error('weather down')));

    const text = await formatAnsweredInvitationCard('accepted', event, viewer, { weatherService: { getForecastAt } });

    expect(text.startsWith(`${t('en').invitation_accepted}\n\n📌 <b>Meeting</b>`)).toBe(true);
  });

  test('a missing event leaves only the answer line', async () => {
    expect(await formatAnsweredInvitationCard('accepted', null, viewer, {})).toBe(t('en').invitation_accepted);
  });
});
