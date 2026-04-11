// src/services/weather/weather-service.ts
import cityTimezones from 'city-timezones';
import { z } from 'zod';
import { notifyLogger } from '../../utils/logger.ts';
import type { DayWeather, EventForecast, HourWeather, WeekWeather } from './types.ts';
import { owmCurrentSchema, owmDailyForecastSchema } from './types.ts';

const WEATHER_EMOJI: { [code: string]: string } = {
  // Thunderstorm
  '2xx': '⛈',
  // Drizzle
  '3xx': '🌧',
  // Rain
  '5xx': '🌧',
  // Snow
  '6xx': '🌨',
  // Atmosphere (fog, mist, etc.)
  '7xx': '🌫',
  // Clear
  '800': '☀️',
  // Clouds
  '80x': '⛅',
};

export function weatherEmoji(conditionCode: number): string {
  if (conditionCode === 800) return WEATHER_EMOJI['800']!;
  if (conditionCode > 800) return WEATHER_EMOJI['80x']!;
  const group = `${Math.floor(conditionCode / 100)}xx`;
  return WEATHER_EMOJI[group] ?? '🌡';
}

interface Coordinates {
  lat: number;
  lon: number;
}

const cityEntrySchema = z.object({
  timezone: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  pop: z.number().optional(),
});

/** Resolve timezone string to approximate lat/lon via city-timezones library */
export function timezoneToCoords(timezone: string): Coordinates | null {
  const matching = cityTimezones.cityMapping.filter((c: z.infer<typeof cityEntrySchema>) => c.timezone === timezone);
  if (matching.length === 0) return null;
  // Pick the most populated city in that timezone
  matching.sort(
    (a: z.infer<typeof cityEntrySchema>, b: z.infer<typeof cityEntrySchema>) => (b.pop ?? 0) - (a.pop ?? 0),
  );
  const best = matching[0]!;
  return { lat: best.lat, lon: best.lng };
}

type FetchFn = (url: string) => Promise<Response>;

interface WeatherServiceDeps {
  apiKey: string;
  /** Override for testing */
  fetchFn?: FetchFn;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class WeatherService {
  private apiKey: string;
  private fetchFn: FetchFn;
  private dayCache = new Map<string, CacheEntry<DayWeather>>();
  private weekCache = new Map<string, CacheEntry<WeekWeather>>();

  constructor(deps: WeatherServiceDeps) {
    this.apiKey = deps.apiKey;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** Get current day weather for a timezone */
  async getDayWeather(timezone: string, lang = 'en'): Promise<DayWeather | null> {
    const coords = timezoneToCoords(timezone);
    if (!coords) {
      notifyLogger.warn({ timezone }, 'Cannot resolve timezone to coordinates for weather');
      return null;
    }
    return this.fetchCurrentWeather(coords, lang);
  }

  /** Get 7-day forecast for a timezone (includes up to 48 hourly points) */
  async getWeekWeather(timezone: string, lang = 'en'): Promise<WeekWeather | null> {
    const coords = timezoneToCoords(timezone);
    if (!coords) {
      notifyLogger.warn({ timezone }, 'Cannot resolve timezone to coordinates for weather');
      return null;
    }
    return this.fetchWeekForecast(coords, lang);
  }

  /**
   * Get forecast anchored to a specific event time.
   * Returns an hourly point when the event is inside the 48h hourly horizon,
   * otherwise a daily point while the event is still inside the 7-day daily horizon.
   * Returns null if the event is in the past or beyond the forecast horizon.
   * Pass `opts.allDay = true` for all-day events — hourly is skipped and the
   * daily forecast for the event's date is used regardless of how close it is.
   */
  async getForecastAt(
    timezone: string,
    eventTimeMs: number,
    lang = 'en',
    opts?: { allDay?: boolean },
  ): Promise<EventForecast | null> {
    const week = await this.getWeekWeather(timezone, lang);
    if (!week) return null;
    return pickForecastAt(week, eventTimeMs, opts);
  }

  private async fetchCurrentWeather(coords: Coordinates, lang: string): Promise<DayWeather | null> {
    const cacheKey = `${coords.lat},${coords.lon},${lang}`;
    const cached = this.dayCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=${lang}&appid=${this.apiKey}`;
      const res = await this.fetchFn(url);
      if (!res.ok) {
        notifyLogger.warn({ status: res.status, coords }, 'OpenWeatherMap current weather request failed');
        return null;
      }
      const data = owmCurrentSchema.parse(await res.json());
      const weather = data.weather[0]!;
      const result: DayWeather = {
        tempMin: Math.round(data.main.temp_min),
        tempMax: Math.round(data.main.temp_max),
        tempCurrent: Math.round(data.main.temp),
        conditionCode: weather.id,
        description: weather.description,
        windSpeed: data.wind.speed,
      };
      // Cache for 30 minutes
      this.dayCache.set(cacheKey, { data: result, expiresAt: Date.now() + 30 * 60_000 });
      return result;
    } catch (err) {
      notifyLogger.error({ err, coords }, 'Failed to fetch current weather');
      return null;
    }
  }

  private async fetchWeekForecast(coords: Coordinates, lang: string): Promise<WeekWeather | null> {
    const cacheKey = `${coords.lat},${coords.lon},${lang}`;
    const cached = this.weekCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${coords.lat}&lon=${coords.lon}&units=metric&lang=${lang}&exclude=minutely,alerts&appid=${this.apiKey}`;
      const res = await this.fetchFn(url);
      if (!res.ok) {
        notifyLogger.warn({ status: res.status, coords }, 'OpenWeatherMap forecast request failed');
        return null;
      }
      const data = owmDailyForecastSchema.parse(await res.json());
      const result: WeekWeather = {
        days: data.daily.slice(0, 8).map((d) => {
          const weather = d.weather[0]!;
          const date = new Date(d.dt * 1000).toISOString().slice(0, 10);
          return {
            date,
            tempMin: Math.round(d.temp.min),
            tempMax: Math.round(d.temp.max),
            conditionCode: weather.id,
            description: weather.description,
            windSpeed: d.wind_speed,
            pop: d.pop,
          };
        }),
        hours: (data.hourly ?? []).map((h) => {
          const weather = h.weather[0]!;
          return {
            dt: h.dt,
            temp: Math.round(h.temp),
            conditionCode: weather.id,
            description: weather.description,
            windSpeed: h.wind_speed,
            pop: h.pop,
          };
        }),
      };
      // Cache for 2 hours
      this.weekCache.set(cacheKey, { data: result, expiresAt: Date.now() + 120 * 60_000 });
      return result;
    } catch (err) {
      notifyLogger.error({ err, coords }, 'Failed to fetch week forecast');
      return null;
    }
  }
}

/**
 * Pick the forecast point that best covers a given event time.
 * Prefers hourly (closest hour within 90 minutes), falls back to daily
 * when the event is beyond the hourly horizon but still within the daily one.
 * For all-day events, hourly is skipped and the daily forecast for the
 * event's date is used — showing the temperature at midnight of a whole-day
 * event is misleading.
 * Returns null for past events or events beyond the daily horizon.
 */
export function pickForecastAt(
  week: WeekWeather,
  eventTimeMs: number,
  opts?: { allDay?: boolean },
): EventForecast | null {
  if (eventTimeMs < Date.now() - 60 * 60_000) return null;

  if (!opts?.allDay) {
    const closestHour = findClosestHour(week.hours, eventTimeMs);
    if (closestHour) return { kind: 'hour', hour: closestHour };
  }

  const eventDate = new Date(eventTimeMs).toISOString().slice(0, 10);
  const day = week.days.find((d) => d.date === eventDate);
  if (day) return { kind: 'day', day };

  return null;
}

/** Find the hourly forecast point whose bucket (±90 min window) contains the event time */
function findClosestHour(hours: HourWeather[], eventTimeMs: number): HourWeather | null {
  if (hours.length === 0) return null;
  let best: HourWeather | null = null;
  let bestDeltaMs = Number.POSITIVE_INFINITY;
  for (const h of hours) {
    const delta = Math.abs(h.dt * 1000 - eventTimeMs);
    if (delta < bestDeltaMs) {
      bestDeltaMs = delta;
      best = h;
    }
  }
  // Hourly buckets are 1h apart — accept if within 90 min of the event
  return bestDeltaMs <= 90 * 60_000 ? best : null;
}
