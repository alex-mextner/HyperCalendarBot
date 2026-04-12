import { describe, expect, test } from 'bun:test';
import {
  formatDayWeatherLine,
  formatEventWeatherLine,
  formatWeekWeatherLine,
} from '../../../src/services/weather/format.ts';
import type { DayWeather, EventForecast } from '../../../src/services/weather/types.ts';

describe('formatDayWeatherLine', () => {
  const baseWeather: DayWeather = {
    tempMin: 5,
    tempMax: 15,
    tempCurrent: 10,
    conditionCode: 800,
    description: 'clear sky',
    windSpeed: 3,
  };

  test('formats current weather in English', () => {
    const result = formatDayWeatherLine('en', baseWeather);
    expect(result).toBe('☀️ 10°C (5..15°C), clear sky');
  });

  test('formats current weather in Russian', () => {
    const ruWeather: DayWeather = { ...baseWeather, description: 'ясно' };
    const result = formatDayWeatherLine('ru', ruWeather);
    expect(result).toBe('☀️ 10°C (5..15°C), ясно');
  });

  test('shows wind when >= 10 m/s', () => {
    const windy: DayWeather = { ...baseWeather, windSpeed: 12.3 };
    const result = formatDayWeatherLine('en', windy);
    expect(result).toContain('💨');
    expect(result).toContain('12 m/s');
  });

  test('shows wind in Russian units', () => {
    const windy: DayWeather = { ...baseWeather, windSpeed: 15 };
    const result = formatDayWeatherLine('ru', windy);
    expect(result).toContain('15 м/с');
  });

  test('hides wind when < 10 m/s', () => {
    const result = formatDayWeatherLine('en', baseWeather);
    expect(result).not.toContain('💨');
  });

  test('shows range when no current temp', () => {
    const forecast: DayWeather = { ...baseWeather, tempCurrent: undefined };
    const result = formatDayWeatherLine('en', forecast);
    expect(result).toBe('☀️ 5..15°C, clear sky');
  });

  test('shows rain emoji for 500 code', () => {
    const rainy: DayWeather = { ...baseWeather, conditionCode: 500, description: 'light rain' };
    const result = formatDayWeatherLine('en', rainy);
    expect(result).toContain('🌧');
  });
});

describe('formatWeekWeatherLine', () => {
  test('formats compact weather line', () => {
    const day: DayWeather = {
      tempMin: -2,
      tempMax: 5,
      conditionCode: 600,
      description: 'snow',
      windSpeed: 8,
    };
    const result = formatWeekWeatherLine('en', day);
    expect(result).toBe('🌨 -2..5°C');
  });
});

describe('formatEventWeatherLine', () => {
  test('hourly forecast shows single temperature at the event time', () => {
    const forecast: EventForecast = {
      kind: 'hour',
      hour: {
        dt: 1_700_000_000,
        temp: 17,
        conditionCode: 800,
        description: 'clear sky',
        windSpeed: 3,
        pop: 0,
      },
    };
    const result = formatEventWeatherLine('en', forecast);
    expect(result).toBe('☀️ 17°C, clear sky');
    expect(result).not.toContain('..');
  });

  test('hourly forecast includes wind when >= 10 m/s', () => {
    const forecast: EventForecast = {
      kind: 'hour',
      hour: {
        dt: 1_700_000_000,
        temp: 9,
        conditionCode: 500,
        description: 'light rain',
        windSpeed: 14.2,
      },
    };
    const result = formatEventWeatherLine('en', forecast);
    expect(result).toContain('💨');
    expect(result).toContain('14 m/s');
  });

  test('daily fallback shows min..max range', () => {
    const forecast: EventForecast = {
      kind: 'day',
      day: {
        date: '2026-04-15',
        tempMin: 5,
        tempMax: 18,
        conditionCode: 801,
        description: 'few clouds',
        windSpeed: 4,
      },
    };
    const result = formatEventWeatherLine('en', forecast);
    expect(result).toBe('⛅ 5..18°C, few clouds');
  });

  test('daily fallback renders in Russian', () => {
    const forecast: EventForecast = {
      kind: 'day',
      day: {
        date: '2026-04-15',
        tempMin: -3,
        tempMax: 2,
        conditionCode: 600,
        description: 'снег',
        windSpeed: 12,
      },
    };
    const result = formatEventWeatherLine('ru', forecast);
    expect(result).toContain('🌨');
    expect(result).toContain('-3..2°C');
    expect(result).toContain('снег');
    expect(result).toContain('12 м/с');
  });
});
