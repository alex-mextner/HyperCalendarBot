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

/** Single-hour forecast point (OpenWeatherMap OneCall hourly) */
export interface HourWeather {
  /** Unix seconds (UTC) — forecast hour start */
  dt: number;
  /** Temperature in Celsius at this hour */
  temp: number;
  /** OpenWeatherMap condition code */
  conditionCode: number;
  /** Human-readable description from API */
  description: string;
  /** Wind speed in m/s */
  windSpeed: number;
  /** Precipitation probability 0-1 */
  pop?: number;
}

/** Weather forecast for a week: up to 8 daily points + up to 48 hourly points */
export interface WeekWeather {
  days: WeekWeatherDay[];
  hours: HourWeather[];
}

/**
 * Forecast anchored to a specific event time.
 * Hourly forecast when the event is within the API's 48-hour hourly horizon,
 * daily forecast when the event is further out but within the 7-day daily horizon.
 */
export type EventForecast = { kind: 'hour'; hour: HourWeather } | { kind: 'day'; day: WeekWeatherDay };

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

const owmForecastHourSchema = z.object({
  dt: z.number(),
  temp: z.number(),
  weather: z.array(owmWeatherItemSchema).min(1),
  wind_speed: z.number(),
  pop: z.number().optional(),
});

export const owmDailyForecastSchema = z.object({
  daily: z.array(owmForecastDaySchema),
  hourly: z.array(owmForecastHourSchema).optional(),
});
