// test/services/location/format-location.test.ts
import { describe, expect, test } from 'bun:test';
import { formatLocationHtml, formatLocationPlain } from '../../../src/services/location/format-location.ts';

describe('formatLocationHtml', () => {
  test('returns empty string for no location', () => {
    const result = formatLocationHtml({
      location: null,
      google_maps_url: null,
      resolved_address: null,
    });
    expect(result).toBe('');
  });

  test('creates Google Maps search link for raw location', () => {
    const result = formatLocationHtml({
      location: 'Кофемания',
      google_maps_url: null,
      resolved_address: null,
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
    });
    expect(result).toContain('55.75,37.60');
    expect(result).toContain('ул. Большая Никитская');
  });

  test('uses resolved_address as display text when available', () => {
    const result = formatLocationHtml({
      location: 'кофемания',
      google_maps_url: 'https://maps.test',
      resolved_address: 'Кофемания, ул. Большая Никитская, 12, Москва',
    });
    expect(result).toContain('Кофемания, ул. Большая Никитская, 12, Москва');
    expect(result).not.toContain('>кофемания<');
  });

  test('escapes HTML in location text', () => {
    const result = formatLocationHtml({
      location: 'Bar <script>',
      google_maps_url: null,
      resolved_address: null,
    });
    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>');
  });
});

describe('formatLocationPlain', () => {
  test('returns empty string for no location', () => {
    expect(formatLocationPlain({ location: null, resolved_address: null })).toBe('');
  });

  test('returns raw location when no resolved address', () => {
    expect(formatLocationPlain({ location: 'Кофемания', resolved_address: null })).toBe('Кофемания');
  });

  test('returns resolved address when available', () => {
    expect(
      formatLocationPlain({
        location: 'кофемания',
        resolved_address: 'Кофемания, ул. Большая Никитская, 12',
      }),
    ).toBe('Кофемания, ул. Большая Никитская, 12');
  });
});
