// test/services/location/geocoding-service.test.ts
import { describe, expect, test } from 'bun:test';
import { buildGoogleMapsSearchUrl, buildGoogleMapsUrl } from '../../../src/services/location/geocoding-service.ts';

describe('buildGoogleMapsUrl', () => {
  test('builds URL with coordinates only', () => {
    const url = buildGoogleMapsUrl(55.7558, 37.6173);
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=55.7558,37.6173');
  });

  test('builds URL with place_id', () => {
    const url = buildGoogleMapsUrl(55.7558, 37.6173, 'ChIJybDUc_xKtUYRTM9XV8zWRD0');
    expect(url).toContain('query_place_id=ChIJybDUc_xKtUYRTM9XV8zWRD0');
    expect(url).toContain('query=55.7558,37.6173');
  });

  test('handles null place_id', () => {
    const url = buildGoogleMapsUrl(55.7558, 37.6173, null);
    expect(url).not.toContain('query_place_id');
  });
});

describe('buildGoogleMapsSearchUrl', () => {
  test('encodes query parameter', () => {
    const url = buildGoogleMapsSearchUrl('Кофемания Москва');
    expect(url).toContain('query=');
    expect(url).toContain(encodeURIComponent('Кофемания Москва'));
  });

  test('handles English address', () => {
    const url = buildGoogleMapsSearchUrl('123 Main St, New York');
    expect(url).toContain(encodeURIComponent('123 Main St, New York'));
  });

  test('handles special characters', () => {
    const url = buildGoogleMapsSearchUrl('Café & Bar, 5th Ave');
    expect(url).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Café & Bar, 5th Ave')}`);
  });
});
