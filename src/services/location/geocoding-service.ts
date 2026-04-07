// src/services/location/geocoding-service.ts
import { z } from 'zod';
import { botLogger } from '../../utils/logger.ts';

const logger = botLogger.child({ module: 'geocoding' });

// --- Zod schemas for Google Maps API responses ---

const GeocodeGeometrySchema = z.object({
  location: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
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
  placeId: string | null;
  googleMapsUrl: string;
}

export interface GeocodingService {
  /** Geocode a free-text address/place name. Optionally bias toward a city. */
  geocodeAddress(query: string, biasCity?: string): Promise<GeocodedLocation[]>;
  /** Reverse-geocode coordinates to an address. */
  reverseGeocode(lat: number, lng: number): Promise<GeocodedLocation | null>;
  /** Search for a place by name using Places API (better for venue names). */
  findPlace(query: string, biasCity?: string): Promise<GeocodedLocation[]>;
}

/** Build a Google Maps URL from coordinates */
export function buildGoogleMapsUrl(lat: number, lng: number, placeId?: string | null): string {
  if (placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}&query_place_id=${placeId}`;
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

export function createGeocodingService(apiKey: string): GeocodingService {
  async function geocodeAddress(query: string, biasCity?: string): Promise<GeocodedLocation[]> {
    const fullQuery = biasCity ? `${query}, ${biasCity}` : query;
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', fullQuery);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');

    try {
      const res = await fetch(url.toString());
      const data = GeocodeResponseSchema.parse(await res.json());
      if (data.status !== 'OK' || data.results.length === 0) {
        logger.debug({ query: fullQuery, status: data.status }, 'Geocode returned no results');
        return [];
      }
      return data.results.slice(0, 5).map((r) => ({
        formattedAddress: r.formatted_address,
        latitude: r.geometry.location.lat,
        longitude: r.geometry.location.lng,
        city: extractCity(r.address_components),
        country: extractCountry(r.address_components),
        placeId: r.place_id ?? null,
        googleMapsUrl: buildGoogleMapsUrl(r.geometry.location.lat, r.geometry.location.lng, r.place_id),
      }));
    } catch (err) {
      logger.error({ err, query: fullQuery }, 'Geocode API request failed');
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
        placeId: r.place_id ?? null,
        googleMapsUrl: buildGoogleMapsUrl(r.geometry.location.lat, r.geometry.location.lng, r.place_id),
      };
    } catch (err) {
      logger.error({ err, lat, lng }, 'Reverse geocode failed');
      return null;
    }
  }

  async function findPlace(query: string, biasCity?: string): Promise<GeocodedLocation[]> {
    const fullQuery = biasCity ? `${query}, ${biasCity}` : query;
    const url = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
    url.searchParams.set('input', fullQuery);
    url.searchParams.set('inputtype', 'textquery');
    url.searchParams.set('fields', 'name,formatted_address,geometry,place_id');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('language', 'ru');

    try {
      const res = await fetch(url.toString());
      const data = PlacesResponseSchema.parse(await res.json());
      if (data.status !== 'OK' || data.candidates.length === 0) {
        return geocodeAddress(query, biasCity);
      }
      const results: GeocodedLocation[] = [];
      for (const c of data.candidates) {
        if (!c.geometry) continue;
        const reverseResult = await reverseGeocode(c.geometry.location.lat, c.geometry.location.lng);
        results.push({
          formattedAddress: c.formatted_address ?? c.name ?? fullQuery,
          latitude: c.geometry.location.lat,
          longitude: c.geometry.location.lng,
          city: reverseResult?.city ?? null,
          country: reverseResult?.country ?? null,
          placeId: c.place_id ?? null,
          googleMapsUrl: buildGoogleMapsUrl(c.geometry.location.lat, c.geometry.location.lng, c.place_id),
        });
      }
      return results;
    } catch (err) {
      logger.error({ err, query: fullQuery }, 'Find place API request failed');
      return geocodeAddress(query, biasCity);
    }
  }

  return { geocodeAddress, reverseGeocode, findPlace };
}
