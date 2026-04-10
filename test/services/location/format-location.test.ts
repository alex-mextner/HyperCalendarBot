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
    });
    expect(result).toBe('');
  });

  test('creates Google Maps search link for raw location', () => {
    const result = formatLocationHtml({
      location: 'Кофемания',
      google_maps_url: null,
      resolved_address: null,
      venue_name: null,
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
    });
    expect(result).toContain('Кофемания — ул. Большая Никитская, 12, Москва');
  });

  test('shows venue_name alone when resolved_address is missing', () => {
    const result = formatLocationHtml({
      location: 'кофемания',
      google_maps_url: null,
      resolved_address: null,
      venue_name: 'Кофемания',
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
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>alert');
  });
});

describe('formatLocationPlain', () => {
  test('returns empty string for no location', () => {
    expect(formatLocationPlain({ location: null, resolved_address: null, venue_name: null })).toBe('');
  });

  test('returns raw location when no resolved address', () => {
    expect(formatLocationPlain({ location: 'Кофемания', resolved_address: null, venue_name: null })).toBe('Кофемания');
  });

  test('returns resolved address when available', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: 'Кофемания, ул. Большая Никитская, 12',
        venue_name: null,
      }),
    ).toBe('Кофемания, ул. Большая Никитская, 12');
  });

  test('returns venue_name — resolved_address when both are set', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: 'ул. Большая Никитская, 12',
        venue_name: 'Кофемания',
      }),
    ).toBe('Кофемания — ул. Большая Никитская, 12');
  });

  test('returns venue_name alone when resolved_address is missing', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: null,
        venue_name: 'Кофемания',
      }),
    ).toBe('Кофемания');
  });
});
