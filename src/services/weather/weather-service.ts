// src/services/weather/weather-service.ts
import cityTimezones from 'city-timezones';
import { notifyLogger } from '../../utils/logger.ts';
import type { DayWeather, WeekWeather } from './types.ts';
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

/** Resolve timezone string to approximate lat/lon via city-timezones library */
export function timezoneToCoords(timezone: string): Coordinates | null {
  const cities = cityTimezones.cityMapping.filter((c: { timezone?: string }) => c.timezone === timezone);
  if (cities.length === 0) return null;
  // Pick the most populated city in that timezone
  cities.sort((a: { pop?: number }, b: { pop?: number }) => (b.pop ?? 0) - (a.pop ?? 0));
  const best = cities[0] as { lat: number; lng: number };
  return { lat: best.lat, lon: best.lng };
}

type FetchFn = (url: string) => Promise<Response>;

interface WeatherServiceDeps {
  apiKey: string;
  /** Override for testing */
  fetchFn?: FetchFn;
}

export class WeatherService {
  private apiKey: string;
  private fetchFn: FetchFn;
  /** In-memory cache: key = "lat,lon:type" → { data, expiresAt } */
  private cache = new Map<string, { data: DayWeather | WeekWeather; expiresAt: number }>();

  constructor(deps: WeatherServiceDeps) {
    this.apiKey = deps.apiKey;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /** Get current day weather for a timezone */
  async getDayWeather(timezone: string): Promise<DayWeather | null> {
    const coords = timezoneToCoords(timezone);
    if (!coords) {
      notifyLogger.warn({ timezone }, 'Cannot resolve timezone to coordinates for weather');
      return null;
    }
    return this.fetchCurrentWeather(coords);
  }

  /** Get 7-day forecast for a timezone */
  async getWeekWeather(timezone: string): Promise<WeekWeather | null> {
    const coords = timezoneToCoords(timezone);
    if (!coords) {
      notifyLogger.warn({ timezone }, 'Cannot resolve timezone to coordinates for weather');
      return null;
    }
    return this.fetchWeekForecast(coords);
  }

  private async fetchCurrentWeather(coords: Coordinates): Promise<DayWeather | null> {
    const cacheKey = `${coords.lat},${coords.lon}:current`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as DayWeather;
    }

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${coords.lat}&lon=${coords.lon}&units=metric&appid=${this.apiKey}`;
      const res = await this.fetchFn(url);
      if (!res.ok) {
        notifyLogger.warn({ status: res.status, coords }, 'OpenWeatherMap current weather request failed');
        return null;
      }
      const raw: unknown = await res.json();
      const data = owmCurrentSchema.parse(raw);
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
      this.cache.set(cacheKey, { data: result, expiresAt: Date.now() + 30 * 60_000 });
      return result;
    } catch (err) {
      notifyLogger.error({ err, coords }, 'Failed to fetch current weather');
      return null;
    }
  }

  private async fetchWeekForecast(coords: Coordinates): Promise<WeekWeather | null> {
    const cacheKey = `${coords.lat},${coords.lon}:week`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data as WeekWeather;
    }

    try {
      const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${coords.lat}&lon=${coords.lon}&units=metric&exclude=minutely,hourly,alerts&appid=${this.apiKey}`;
      const res = await this.fetchFn(url);
      if (!res.ok) {
        notifyLogger.warn({ status: res.status, coords }, 'OpenWeatherMap forecast request failed');
        return null;
      }
      const raw: unknown = await res.json();
      const data = owmDailyForecastSchema.parse(raw);
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
      };
      // Cache for 2 hours
      this.cache.set(cacheKey, { data: result, expiresAt: Date.now() + 120 * 60_000 });
      return result;
    } catch (err) {
      notifyLogger.error({ err, coords }, 'Failed to fetch week forecast');
      return null;
    }
  }
}
