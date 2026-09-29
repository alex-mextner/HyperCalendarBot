// test/services/location/geocoding-service.test.ts
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  buildGoogleMapsSearchUrl,
  buildGoogleMapsUrl,
  createGeocodingService,
  type GeoBounds,
} from '../../../src/services/location/geocoding-service.ts';

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

  test('a place id picked in a Telegram client cannot add parameters to the link', () => {
    // A venue's google_place_id comes from the user's client, not from Google
    const url = new URL(buildGoogleMapsUrl(44.8176, 20.4569, 'ChIJ-venue&query=0,0'));
    expect(url.searchParams.get('query_place_id')).toBe('ChIJ-venue&query=0,0');
    expect(url.searchParams.getAll('query')).toEqual(['44.8176,20.4569']);
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

describe('Google requests are biased toward the home area', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const serbia: GeoBounds = { south: 42.23, west: 18.82, north: 46.19, east: 23.01 };
  const serbiaComponents = [{ long_name: 'Сербия', short_name: 'RS', types: ['country', 'political'] }];
  const serbiaResult = {
    formatted_address: 'Сербия',
    geometry: {
      location: { lat: 44.02, lng: 21.01 },
      viewport: { northeast: { lat: 46.19, lng: 23.01 }, southwest: { lat: 42.23, lng: 18.82 } },
    },
    address_components: serbiaComponents,
    place_id: 'country-rs',
  };

  /** Answers every Google request with `body` and records the requested URLs. */
  function googleReturning(body: { [key: string]: unknown }): URL[] {
    const requests: URL[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      requests.push(new URL(typeof input === 'string' ? input : input.toString()));
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    return requests;
  }

  test('Find Place sends the bias rectangle instead of relying on the server IP location', async () => {
    const requests = googleReturning({ status: 'ZERO_RESULTS', candidates: [], results: [] });

    await createGeocodingService('key').findPlace('Kafana Sunce', { countryCode: 'RS', bounds: serbia });

    const findPlace = requests.find((u) => u.pathname.endsWith('/findplacefromtext/json'));
    expect(findPlace?.searchParams.get('input')).toBe('Kafana Sunce');
    expect(findPlace?.searchParams.get('locationbias')).toBe('rectangle:42.23,18.82|46.19,23.01');
  });

  test('Geocoding sends the region and bounds, and the text query stays as typed', async () => {
    const requests = googleReturning({ status: 'ZERO_RESULTS', results: [] });

    await createGeocodingService('key').geocodeAddress('Dunavska 1', { countryCode: 'RS', bounds: serbia });

    expect(requests[0]?.searchParams.get('address')).toBe('Dunavska 1');
    expect(requests[0]?.searchParams.get('region')).toBe('rs');
    expect(requests[0]?.searchParams.get('bounds')).toBe('42.23,18.82|46.19,23.01');
  });

  test('the United Kingdom is sent as its ccTLD region', async () => {
    const requests = googleReturning({ status: 'ZERO_RESULTS', results: [] });

    await createGeocodingService('key').geocodeAddress('Baker Street', { countryCode: 'GB', bounds: null });

    expect(requests[0]?.searchParams.get('region')).toBe('uk');
    expect(requests[0]?.searchParams.has('bounds')).toBe(false);
  });

  test('results carry the ISO country code', async () => {
    googleReturning({ status: 'OK', results: [serbiaResult] });

    const [result] = await createGeocodingService('key').geocodeAddress('Сербия');

    expect(result?.countryCode).toBe('RS');
  });

  test('a country is located through a country component filter', async () => {
    const requests = googleReturning({ status: 'OK', results: [serbiaResult] });

    const area = await createGeocodingService('key').locateArea({ city: null, countryCode: 'RS' });

    expect(requests[0]?.searchParams.get('components')).toBe('country:RS');
    expect(requests[0]?.searchParams.has('address')).toBe(false);
    expect(area).toEqual({ latitude: 44.02, longitude: 21.01, countryCode: 'RS', bounds: serbia });
  });

  test('a city is only ranked toward the country, so a city abroad reports its real country', async () => {
    const requests = googleReturning({
      status: 'OK',
      results: [
        {
          formatted_address: 'Zeedorp, Нидерланды',
          geometry: {
            location: { lat: 51.58, lng: 3.62 },
            viewport: { northeast: { lat: 51.6, lng: 3.64 }, southwest: { lat: 51.57, lng: 3.6 } },
          },
          address_components: [{ long_name: 'Нидерланды', short_name: 'NL', types: ['country', 'political'] }],
        },
      ],
    });

    const area = await createGeocodingService('key').locateArea({ city: 'Zeedorp', countryCode: 'RS' });

    expect(requests[0]?.searchParams.get('address')).toBe('Zeedorp');
    expect(requests[0]?.searchParams.get('region')).toBe('rs');
    expect(requests[0]?.searchParams.has('components')).toBe(false);
    expect(area?.countryCode).toBe('NL');
  });

  test('nothing to locate makes no request', async () => {
    const requests = googleReturning({ status: 'OK', results: [serbiaResult] });

    expect(await createGeocodingService('key').locateArea({ city: null, countryCode: null })).toBeNull();
    expect(requests).toEqual([]);
  });
});
