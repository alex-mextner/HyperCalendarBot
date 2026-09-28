// test/services/location/format-location.test.ts
import { describe, expect, test } from 'bun:test';
import { formatLocationHtml, formatLocationPlain } from '../../../src/services/location/format-location.ts';

describe('formatLocationHtml', () => {
  test('returns empty string for no location', () => {
    const result = formatLocationHtml({
      location: null,
      google_maps_url: null,
      resolved_address: null,
      venue_name: null,
      location_verified: 0,
    });
    expect(result).toBe('');
  });

  test('creates Google Maps search link for raw location', () => {
    const result = formatLocationHtml({
      location: 'Кофемания',
      google_maps_url: null,
      resolved_address: null,
      venue_name: null,
      location_verified: 0,
    });
    expect(result).toContain('<a href="');
    expect(result).toContain('Кофемания');
    expect(result).toContain('google.com/maps');
  });

  test('uses google_maps_url when available', () => {
    const result = formatLocationHtml({
      location: 'Кофемания',
      google_maps_url: 'https://www.google.com/maps/search/?api=1&query=55.75,37.60',
      resolved_address: 'Кофемания, ул. Большая Никитская, 12',
      venue_name: null,
      location_verified: 1,
    });
    expect(result).toContain('55.75,37.60');
    expect(result).toContain('ул. Большая Никитская');
  });

  test('uses resolved_address as display text when available', () => {
    const result = formatLocationHtml({
      location: 'кофемания',
      google_maps_url: 'https://maps.test',
      resolved_address: 'Кофемания, ул. Большая Никитская, 12, Москва',
      venue_name: null,
      location_verified: 1,
    });
    expect(result).toContain('Кофемания, ул. Большая Никитская, 12, Москва');
    expect(result).not.toContain('>кофемания<');
  });

  test('escapes HTML in location text', () => {
    const result = formatLocationHtml({
      location: 'Bar <script>',
      google_maps_url: null,
      resolved_address: null,
      venue_name: null,
      location_verified: 0,
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });

  test('shows venue_name + resolved_address as "Venue — Address"', () => {
    const result = formatLocationHtml({
      location: 'кофемания',
      google_maps_url: 'https://maps.google.com/?q=55.75,37.6',
      resolved_address: 'ул. Большая Никитская, 12, Москва',
      venue_name: 'Кофемания',
      location_verified: 1,
    });
    expect(result).toContain('Кофемания — ул. Большая Никитская, 12, Москва');
  });

  test('shows venue_name alone when resolved_address is missing', () => {
    const result = formatLocationHtml({
      location: 'кофемания',
      google_maps_url: null,
      resolved_address: null,
      venue_name: 'Кофемания',
      location_verified: 1,
    });
    expect(result).toContain('>Кофемания</a>');
    // Should not have the dash separator if no address
    expect(result).not.toContain('Кофемания — ');
  });

  test('escapes HTML in venue_name too', () => {
    const result = formatLocationHtml({
      location: 'evil',
      google_maps_url: null,
      resolved_address: null,
      venue_name: '<script>alert(1)</script>',
      location_verified: 1,
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>alert');
  });

  test('an unconfirmed place shows only the typed text, linked to a map search for it', () => {
    const result = formatLocationHtml({
      location: 'sonder',
      google_maps_url: 'https://www.google.com/maps/place/?q=place_id:dutch-hotel',
      resolved_address: 'Damrak 1, Amsterdam',
      venue_name: 'Sonder Hotel',
      location_verified: 0,
    });
    expect(result).toBe('<a href="https://www.google.com/maps/search/?api=1&amp;query=sonder">sonder</a>');
  });
});

describe('formatLocationPlain', () => {
  test('returns empty string for no location', () => {
    expect(
      formatLocationPlain({ location: null, resolved_address: null, venue_name: null, location_verified: 0 }),
    ).toBe('');
  });

  test('returns raw location when no resolved address', () => {
    expect(
      formatLocationPlain({ location: 'Кофемания', resolved_address: null, venue_name: null, location_verified: 0 }),
    ).toBe('Кофемания');
  });

  test('returns resolved address when available', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: 'Кофемания, ул. Большая Никитская, 12',
        venue_name: null,
        location_verified: 1,
      }),
    ).toBe('Кофемания, ул. Большая Никитская, 12');
  });

  test('returns venue_name — resolved_address when both are set', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: 'ул. Большая Никитская, 12',
        venue_name: 'Кофемания',
        location_verified: 1,
      }),
    ).toBe('Кофемания — ул. Большая Никитская, 12');
  });

  test('returns venue_name alone when resolved_address is missing', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: null,
        venue_name: 'Кофемания',
        location_verified: 1,
      }),
    ).toBe('Кофемания');
  });

  test('returns exactly the typed text while the location is unverified, ignoring any geocode', () => {
    expect(
      formatLocationPlain({
        location: 'кафе у парка',
        resolved_address: 'ул. Примерная, 1, Москва',
        venue_name: 'Кафе Ромашка',
        location_verified: 0,
      }),
    ).toBe('кафе у парка');
  });

  test('returns a place confirmed with a pin even when the event has no typed text', () => {
    expect(
      formatLocationPlain({
        location: null,
        resolved_address: 'ул. Примерная, 1, Москва',
        venue_name: 'Кафе Ромашка',
        location_verified: 1,
      }),
    ).toBe('Кафе Ромашка — ул. Примерная, 1, Москва');
  });

  test('returns nothing for a stale unverified place on an event without typed text', () => {
    expect(
      formatLocationPlain({
        location: null,
        resolved_address: 'ул. Примерная, 1, Москва',
        venue_name: 'Кафе Ромашка',
        location_verified: 0,
      }),
    ).toBe('');
  });
});
