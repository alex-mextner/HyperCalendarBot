import { describe, expect, test } from 'bun:test';
import { formatDayWeatherLine, formatWeekWeatherLine } from '../../../src/services/weather/format.ts';
import type { DayWeather } from '../../../src/services/weather/types.ts';

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
    const result = formatDayWeatherLine('ru', baseWeather);
    expect(result).toBe('☀️ 10°C (5..15°C), clear sky');
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
