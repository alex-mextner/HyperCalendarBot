// src/services/weather/types.ts
import { z } from 'zod';

/** Weather condition for a single day */
export interface DayWeather {
  /** Temperature in Celsius */
  tempMin: number;
  tempMax: number;
  /** Current temp (only for "today" weather) */
  tempCurrent?: number;
  /** OpenWeatherMap condition code (e.g. 800 = clear) */
  conditionCode: number;
  /** Human-readable description from API */
  description: string;
  /** Wind speed in m/s */
  windSpeed: number;
  /** Precipitation probability 0-1 (forecast only) */
  pop?: number;
}

/** A day in the weekly forecast — DayWeather with a date attached */
export interface WeekWeatherDay extends DayWeather {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
}

/** Weather forecast for a week (7 days) */
export interface WeekWeather {
  days: WeekWeatherDay[];
}

// Zod schemas for OpenWeatherMap API responses

const owmWeatherItemSchema = z.object({
  id: z.number(),
  description: z.string(),
});

export const owmCurrentSchema = z.object({
  main: z.object({
    temp: z.number(),
    temp_min: z.number(),
    temp_max: z.number(),
  }),
  weather: z.array(owmWeatherItemSchema).min(1),
  wind: z.object({
    speed: z.number(),
  }),
});

const owmForecastDaySchema = z.object({
  dt: z.number(),
  temp: z.object({
    min: z.number(),
    max: z.number(),
  }),
  weather: z.array(owmWeatherItemSchema).min(1),
  wind_speed: z.number(),
  pop: z.number().optional(),
});

export const owmDailyForecastSchema = z.object({
  daily: z.array(owmForecastDaySchema),
});
