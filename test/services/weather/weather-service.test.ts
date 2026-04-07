import { describe, expect, mock, test } from 'bun:test';
import { timezoneToCoords, WeatherService, weatherEmoji } from '../../../src/services/weather/weather-service.ts';

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
});
