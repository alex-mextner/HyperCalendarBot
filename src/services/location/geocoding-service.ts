// src/services/location/geocoding-service.ts
import { z } from 'zod';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'geocoding' });

// --- Zod schemas for Google Maps API responses ---

const LatLngSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

const GeocodeGeometrySchema = z.object({
  location: LatLngSchema,
  viewport: z.object({ northeast: LatLngSchema, southwest: LatLngSchema }).optional(),
});

const AddressComponentSchema = z.object({
  long_name: z.string(),
  short_name: z.string(),
  types: z.array(z.string()),
});

const GeocodeResultSchema = z.object({
  formatted_address: z.string(),
  geometry: GeocodeGeometrySchema,
  address_components: z.array(AddressComponentSchema),
  place_id: z.string().optional(),
});

const GeocodeResponseSchema = z.object({
  status: z.string(),
  results: z.array(GeocodeResultSchema),
});

const PlaceCandidateSchema = z.object({
  name: z.string().optional(),
  formatted_address: z.string().optional(),
  geometry: GeocodeGeometrySchema.optional(),
  place_id: z.string().optional(),
});

const PlacesResponseSchema = z.object({
  status: z.string(),
  candidates: z.array(PlaceCandidateSchema),
});

// --- Public types ---

export interface GeocodedLocation {
  formattedAddress: string;
  latitude: number;
  longitude: number;
  city: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2 code of the country the place is in. */
  countryCode?: string | null;
  placeId: string | null;
  googleMapsUrl: string;
  /** Venue/organization name (only when found via Places API by business name). */
  venueName?: string | null;
}

/** Rectangle in decimal degrees. */
export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Area that searches prefer. It only biases the ranking; results outside it are still returned. */
export interface GeocodingBias {
  /** ISO 3166-1 alpha-2 code, sent as the Geocoding API region bias. */
  countryCode: string | null;
  /** Sent as the Geocoding API `bounds` and the Find Place `locationbias` rectangle. */
  bounds: GeoBounds | null;
}

/** A located city or country. */
export interface GeocodedArea {
  latitude: number;
  longitude: number;
  countryCode: string | null;
  bounds: GeoBounds;
}

export interface GeocodingService {
  /** Geocode a free-text address/place name, preferring results inside the bias area. */
  geocodeAddress(query: string, bias?: GeocodingBias): Promise<GeocodedLocation[]>;
  /** Reverse-geocode coordinates to an address. */
  reverseGeocode(lat: number, lng: number): Promise<GeocodedLocation | null>;
  /** Search for a place by name using Places API (better for venue names), preferring the bias area. */
  findPlace(query: string, bias?: GeocodingBias): Promise<GeocodedLocation[]>;
  /**
   * Locate a city (ranked toward the country, not restricted to it, so a city in another country is
   * reported as such) or, without a city, the country itself. Null when neither is given or found.
   */
  locateArea(area: { city: string | null; countryCode: string | null }): Promise<GeocodedArea | null>;
}

/**
 * Build a Google Maps URL from coordinates. The place id is encoded: a Telegram venue's id comes
 * from the user's client, not from Google.
 */
export function buildGoogleMapsUrl(lat: number, lng: number, placeId?: string | null): string {
  if (placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${encodeURIComponent(placeId)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** Build a Google Maps search URL from a text query */
export function buildGoogleMapsSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function extractCity(components: z.infer<typeof AddressComponentSchema>[]): string | null {
  for (const comp of components) {
    if (comp.types.includes('locality')) return comp.long_name;
  }
  for (const comp of components) {
    if (comp.types.includes('administrative_area_level_1')) return comp.long_name;
  }
  return null;
}

function extractCountry(components: z.infer<typeof AddressComponentSchema>[]): string | null {
  for (const comp of components) {
    if (comp.types.includes('country')) return comp.long_name;
  }
  return null;
}

function extractCountryCode(components: z.infer<typeof AddressComponentSchema>[]): string | null {
  for (const comp of components) {
    if (comp.types.includes('country')) return comp.short_name;
  }
  return null;
}

/** Geocoding `region` takes a ccTLD, which differs from the ISO code for the United Kingdom. */
function regionCode(countryCode: string): string {
  return countryCode === 'GB' ? 'uk' : countryCode.toLowerCase();
}

export function createGeocodingService(apiKey: string): GeocodingService {
  async function geocodeAddress(query: string, bias?: GeocodingBias): Promise<GeocodedLocation[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');
    if (bias?.countryCode) url.searchParams.set('region', regionCode(bias.countryCode));
    if (bias?.bounds) {
      const { south, west, north, east } = bias.bounds;
      url.searchParams.set('bounds', `${south},${west}|${north},${east}`);
    }

    try {
      const res = await fetch(url.toString());
      const data = GeocodeResponseSchema.parse(await res.json());
      if (data.status !== 'OK' || data.results.length === 0) {
        logger.debug({ query, status: data.status }, 'Geocode returned no results');
        return [];
      }
      return data.results.slice(0, 5).map((r) => ({
        formattedAddress: r.formatted_address,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        city: extractCity(r.address_components),
        country: extractCountry(r.address_components),
        countryCode: extractCountryCode(r.address_components),
        placeId: r.place_id ?? null,
        googleMapsUrl: buildGoogleMapsUrl(r.geometry.location.lat, r.geometry.location.lng, r.place_id),
        venueName: null, // geocode API doesn't return venue names
      }));
    } catch (err) {
      logger.error({ err, query }, 'Geocode API request failed');
      return [];
    }
  }

  async function reverseGeocode(lat: number, lng: number): Promise<GeocodedLocation | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('latlng', `${lat},${lng}`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');

    try {
      const res = await fetch(url.toString());
      const data = GeocodeResponseSchema.parse(await res.json());
      if (data.status !== 'OK' || data.results.length === 0) return null;
      const r = data.results[0]!;
      return {
        formattedAddress: r.formatted_address,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        city: extractCity(r.address_components),
        country: extractCountry(r.address_components),
        countryCode: extractCountryCode(r.address_components),
        placeId: r.place_id ?? null,
        googleMapsUrl: buildGoogleMapsUrl(r.geometry.location.lat, r.geometry.location.lng, r.place_id),
        venueName: null,
      };
    } catch (err) {
      logger.error({ err, lat, lng }, 'Reverse geocode failed');
      return null;
    }
  }

  async function findPlace(query: string, bias?: GeocodingBias): Promise<GeocodedLocation[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
    url.searchParams.set('input', query);
    url.searchParams.set('inputtype', 'textquery');
    url.searchParams.set('fields', 'name,formatted_address,geometry,place_id');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');
    // Without an explicit bias Find Place ranks by the caller's IP, i.e. the server's data centre.
    if (bias?.bounds) {
      const { south, west, north, east } = bias.bounds;
      url.searchParams.set('locationbias', `rectangle:${south},${west}|${north},${east}`);
    }

    try {
      const res = await fetch(url.toString());
      const data = PlacesResponseSchema.parse(await res.json());
      if (data.status !== 'OK' || data.candidates.length === 0) {
        return geocodeAddress(query, bias);
      }
      const results: GeocodedLocation[] = [];
      for (const c of data.candidates) {
        if (!c.geometry) continue;
        const reverseResult = await reverseGeocode(c.geometry.location.lat, c.geometry.location.lng);
        results.push({
          formattedAddress: c.formatted_address ?? c.name ?? query,
          latitude: c.geometry.location.lat,
          longitude: c.geometry.location.lng,
          city: reverseResult?.city ?? null,
          country: reverseResult?.country ?? null,
          countryCode: reverseResult?.countryCode ?? null,
          placeId: c.place_id ?? null,
          googleMapsUrl: buildGoogleMapsUrl(c.geometry.location.lat, c.geometry.location.lng, c.place_id),
          // Places API returns the business/venue name (e.g. "Кофемания")
          venueName: c.name ?? null,
        });
      }
      return results;
    } catch (err) {
      logger.error({ err, query }, 'Find place API request failed');
      return geocodeAddress(query, bias);
    }
  }

  async function locateArea(area: { city: string | null; countryCode: string | null }): Promise<GeocodedArea | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    if (area.city) {
      url.searchParams.set('address', area.city);
      if (area.countryCode) url.searchParams.set('region', regionCode(area.countryCode));
    } else if (area.countryCode) {
      url.searchParams.set('components', `country:${area.countryCode}`);
    } else {
      return null;
    }
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');

    try {
      const res = await fetch(url.toString());
      const data = GeocodeResponseSchema.parse(await res.json());
      const r = data.status === 'OK' ? data.results[0] : undefined;
      if (!r?.geometry.viewport) {
        logger.debug({ area, status: data.status }, 'Area geocode returned no viewport');
        return null;
      }
      const { southwest, northeast } = r.geometry.viewport;
      return {
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        countryCode: extractCountryCode(r.address_components),
        bounds: { south: southwest.lat, west: southwest.lng, north: northeast.lat, east: northeast.lng },
      };
    } catch (err) {
      logger.error({ err, area }, 'Area geocode failed');
      return null;
    }
  }

  return { geocodeAddress, reverseGeocode, findPlace, locateArea };
}
