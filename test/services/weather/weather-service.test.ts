import { describe, expect, mock, test } from 'bun:test';
import type { WeekWeather } from '../../../src/services/weather/types.ts';
import {
  pickForecastAt,
  timezoneToCoords,
  WeatherService,
  weatherEmoji,
} from '../../../src/services/weather/weather-service.ts';

describe('timezoneToCoords', () => {
  test('resolves Europe/Moscow to approximate Moscow coordinates', () => {
    const coords = timezoneToCoords('Europe/Moscow');
    expect(coords).not.toBeNull();
    expect(coords!.lat).toBeCloseTo(55.75, 0);
    expect(coords!.lon).toBeCloseTo(37.62, 0);
  });

  test('resolves America/New_York', () => {
    const coords = timezoneToCoords('America/New_York');
    expect(coords).not.toBeNull();
    expect(coords!.lat).toBeGreaterThan(40);
    expect(coords!.lon).toBeLessThan(-70);
  });

  test('returns null for unknown timezone', () => {
    expect(timezoneToCoords('Invalid/Timezone')).toBeNull();
  });
});

describe('weatherEmoji', () => {
  test('returns sun for clear sky (800)', () => {
    expect(weatherEmoji(800)).toBe('☀️');
  });

  test('returns clouds for 801-804', () => {
    expect(weatherEmoji(801)).toBe('⛅');
    expect(weatherEmoji(804)).toBe('⛅');
  });

  test('returns rain for 5xx codes', () => {
    expect(weatherEmoji(500)).toBe('🌧');
    expect(weatherEmoji(502)).toBe('🌧');
  });

  test('returns snow for 6xx codes', () => {
    expect(weatherEmoji(600)).toBe('🌨');
  });

  test('returns thunderstorm for 2xx codes', () => {
    expect(weatherEmoji(200)).toBe('⛈');
  });

  test('returns fog for 7xx codes', () => {
    expect(weatherEmoji(701)).toBe('🌫');
  });

  test('returns thermometer for unknown codes', () => {
    expect(weatherEmoji(100)).toBe('🌡');
  });
});

describe('WeatherService', () => {
  function makeMockFetch(response: unknown, status = 200) {
    return mock(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(response),
      } as Response),
    );
  }

  test('getDayWeather returns parsed weather for valid timezone', async () => {
    const mockResponse = {
      main: { temp: 15.3, temp_min: 12.1, temp_max: 18.7 },
      weather: [{ id: 800, description: 'clear sky' }],
      wind: { speed: 3.5 },
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test-key', fetchFn });

    const result = await service.getDayWeather('Europe/Moscow');

    expect(result).not.toBeNull();
    expect(result!.tempCurrent).toBe(15);
    expect(result!.tempMin).toBe(12);
    expect(result!.tempMax).toBe(19);
    expect(result!.conditionCode).toBe(800);
    expect(result!.description).toBe('clear sky');
    expect(result!.windSpeed).toBe(3.5);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('appid=test-key');
    expect(url).toContain('units=metric');
    expect(url).toContain('lang=en');
  });

  test('getDayWeather passes lang parameter to API', async () => {
    const mockResponse = {
      main: { temp: 15, temp_min: 12, temp_max: 18 },
      weather: [{ id: 800, description: 'ясно' }],
      wind: { speed: 3 },
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test-key', fetchFn });

    const result = await service.getDayWeather('Europe/Moscow', 'ru');

    expect(result).not.toBeNull();
    expect(result!.description).toBe('ясно');
    const url = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('lang=ru');
  });

  test('getDayWeather returns null for unknown timezone', async () => {
    const fetchFn = makeMockFetch({});
    const service = new WeatherService({ apiKey: 'test-key', fetchFn });

    const result = await service.getDayWeather('Invalid/Zone');
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('getDayWeather returns null on API error', async () => {
    const fetchFn = makeMockFetch({}, 401);
    const service = new WeatherService({ apiKey: 'bad-key', fetchFn });

    const result = await service.getDayWeather('Europe/Moscow');
    expect(result).toBeNull();
  });

  test('getDayWeather uses cache on second call', async () => {
    const mockResponse = {
      main: { temp: 10, temp_min: 8, temp_max: 12 },
      weather: [{ id: 801, description: 'few clouds' }],
      wind: { speed: 2.0 },
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test-key', fetchFn });

    await service.getDayWeather('Europe/Moscow');
    await service.getDayWeather('Europe/Moscow');

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('getWeekWeather returns parsed forecast', async () => {
    const mockResponse = {
      daily: [
        {
          dt: 1712188800,
          temp: { min: 5, max: 12 },
          weather: [{ id: 800, description: 'clear' }],
          wind_speed: 3,
          pop: 0.1,
        },
        {
          dt: 1712275200,
          temp: { min: 3, max: 10 },
          weather: [{ id: 500, description: 'rain' }],
          wind_speed: 5,
          pop: 0.8,
        },
      ],
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test-key', fetchFn });

    const result = await service.getWeekWeather('Europe/Moscow');

    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(2);
    expect(result!.days[0]!.tempMin).toBe(5);
    expect(result!.days[0]!.tempMax).toBe(12);
    expect(result!.days[1]!.conditionCode).toBe(500);
  });

  test('getWeekWeather returns null on API failure', async () => {
    const fetchFn = makeMockFetch({}, 500);
    const service = new WeatherService({ apiKey: 'key', fetchFn });

    const result = await service.getWeekWeather('Europe/Moscow');
    expect(result).toBeNull();
  });

  test('getWeekWeather parses hourly points when present', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const mockResponse = {
      daily: [
        {
          dt: nowSec,
          temp: { min: 5, max: 15 },
          weather: [{ id: 800, description: 'clear' }],
          wind_speed: 3,
          pop: 0,
        },
      ],
      hourly: [
        {
          dt: nowSec,
          temp: 10.4,
          weather: [{ id: 801, description: 'few clouds' }],
          wind_speed: 2.1,
          pop: 0.1,
        },
        {
          dt: nowSec + 3600,
          temp: 11.7,
          weather: [{ id: 801, description: 'few clouds' }],
          wind_speed: 2.5,
          pop: 0.15,
        },
      ],
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test', fetchFn });

    const result = await service.getWeekWeather('Europe/Moscow');
    expect(result).not.toBeNull();
    expect(result!.hours).toHaveLength(2);
    expect(result!.hours[0]!.temp).toBe(10);
    expect(result!.hours[0]!.conditionCode).toBe(801);
    expect(result!.hours[1]!.temp).toBe(12);
    const url = (fetchFn.mock.calls[0] as unknown as [string])[0];
    expect(url).not.toContain('hourly');
  });

  test('getWeekWeather tolerates missing hourly field (legacy API response)', async () => {
    const mockResponse = {
      daily: [
        {
          dt: 1_000_000,
          temp: { min: 0, max: 10 },
          weather: [{ id: 800, description: 'clear' }],
          wind_speed: 1,
        },
      ],
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test', fetchFn });

    const result = await service.getWeekWeather('Europe/Moscow');
    expect(result).not.toBeNull();
    expect(result!.hours).toEqual([]);
  });

  test('getForecastAt returns hourly point when event is within hourly horizon', async () => {
    const eventTimeMs = Date.now() + 2 * 60 * 60 * 1000; // 2h ahead
    const eventSec = Math.floor(eventTimeMs / 1000);
    const mockResponse = {
      daily: [
        {
          dt: eventSec,
          temp: { min: 5, max: 15 },
          weather: [{ id: 800, description: 'clear' }],
          wind_speed: 3,
        },
      ],
      hourly: [
        {
          dt: eventSec - 60, // exact match (off by 1 min)
          temp: 14.2,
          weather: [{ id: 800, description: 'clear sky' }],
          wind_speed: 4,
          pop: 0,
        },
      ],
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test', fetchFn });

    const result = await service.getForecastAt('Europe/Moscow', eventTimeMs);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('hour');
    if (result!.kind === 'hour') {
      expect(result!.hour.temp).toBe(14);
      expect(result!.hour.description).toBe('clear sky');
    }
  });

  test('getForecastAt falls back to daily when event is beyond hourly horizon', async () => {
    const eventTimeMs = Date.now() + 4 * 24 * 60 * 60 * 1000; // 4 days ahead
    const eventDate = new Date(eventTimeMs).toISOString().slice(0, 10);
    const mockResponse = {
      daily: [
        {
          dt: Math.floor(eventTimeMs / 1000),
          temp: { min: 3, max: 12 },
          weather: [{ id: 500, description: 'light rain' }],
          wind_speed: 6,
          pop: 0.7,
        },
      ],
      hourly: [], // no hourly for events that far out
    };
    const fetchFn = makeMockFetch(mockResponse);
    const service = new WeatherService({ apiKey: 'test', fetchFn });

    const result = await service.getForecastAt('Europe/Moscow', eventTimeMs);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('day');
    if (result!.kind === 'day') {
      expect(result!.day.date).toBe(eventDate);
      expect(result!.day.tempMin).toBe(3);
      expect(result!.day.tempMax).toBe(12);
    }
  });

  test('getForecastAt returns null when service fails to fetch', async () => {
    const fetchFn = makeMockFetch({}, 500);
    const service = new WeatherService({ apiKey: 'test', fetchFn });
    const result = await service.getForecastAt('Europe/Moscow', Date.now() + 3600_000);
    expect(result).toBeNull();
  });
});

describe('pickForecastAt', () => {
  function buildWeek(eventTimeMs: number, extras?: Partial<WeekWeather>): WeekWeather {
    const eventSec = Math.floor(eventTimeMs / 1000);
    return {
      days: [
        {
          date: new Date(eventTimeMs).toISOString().slice(0, 10),
          tempMin: 5,
          tempMax: 15,
          conditionCode: 800,
          description: 'clear',
          windSpeed: 3,
          pop: 0.1,
        },
      ],
      hours: [
        {
          dt: eventSec,
          temp: 12,
          conditionCode: 801,
          description: 'few clouds',
          windSpeed: 3,
          pop: 0.05,
        },
      ],
      ...extras,
    };
  }

  test('prefers hourly point when close enough', () => {
    const eventMs = Date.now() + 3600_000;
    const week = buildWeek(eventMs);
    const result = pickForecastAt(week, eventMs);
    expect(result?.kind).toBe('hour');
  });

  test('falls back to daily when no hourly within 90 minutes', () => {
    const eventMs = Date.now() + 5 * 24 * 60 * 60 * 1000;
    const week = buildWeek(eventMs, { hours: [] });
    const result = pickForecastAt(week, eventMs);
    expect(result?.kind).toBe('day');
  });

  test('returns null for events well in the past', () => {
    const eventMs = Date.now() - 3 * 60 * 60 * 1000;
    const week = buildWeek(eventMs, { hours: [] });
    const result = pickForecastAt(week, eventMs);
    expect(result).toBeNull();
  });

  test('returns null when event date is beyond the daily horizon', () => {
    const eventMs = Date.now() + 20 * 24 * 60 * 60 * 1000;
    const week = buildWeek(Date.now() + 3600_000, { hours: [] });
    const result = pickForecastAt(week, eventMs);
    expect(result).toBeNull();
  });
});
