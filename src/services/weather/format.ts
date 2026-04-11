// src/services/weather/format.ts
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { DayWeather, EventForecast } from './types.ts';
import { weatherEmoji } from './weather-service.ts';

/** Format a single day's weather as a compact one-liner for agenda messages */
export function formatDayWeatherLine(lang: Lang, weather: DayWeather): string {
  const l = t(lang).weather;
  const emoji = weatherEmoji(weather.conditionCode);
  const temp =
    weather.tempCurrent !== undefined
      ? l.tempCurrent(weather.tempCurrent, weather.tempMin, weather.tempMax)
      : l.tempRange(weather.tempMin, weather.tempMax);
  const wind = weather.windSpeed >= 10 ? ` 💨 ${l.wind(Math.round(weather.windSpeed))}` : '';
  return `${emoji} ${temp}, ${weather.description}${wind}`;
}

/**
 * Format the weather forecast anchored to a specific event time.
 * Hourly: shows the exact temperature at that hour (not the day's min/max).
 * Daily: falls back to the day's min/max range when the event is beyond the hourly horizon.
 */
export function formatEventWeatherLine(lang: Lang, forecast: EventForecast): string {
  const l = t(lang).weather;
  if (forecast.kind === 'hour') {
    const h = forecast.hour;
    const emoji = weatherEmoji(h.conditionCode);
    const temp = `${h.temp}°C`;
    const wind = h.windSpeed >= 10 ? ` 💨 ${l.wind(Math.round(h.windSpeed))}` : '';
    return `${emoji} ${temp}, ${h.description}${wind}`;
  }
  const d = forecast.day;
  const emoji = weatherEmoji(d.conditionCode);
  const wind = d.windSpeed >= 10 ? ` 💨 ${l.wind(Math.round(d.windSpeed))}` : '';
  return `${emoji} ${l.tempRange(d.tempMin, d.tempMax)}, ${d.description}${wind}`;
}

/** Format weather for weekly digest — one compact line per day */
export function formatWeekWeatherLine(lang: Lang, day: DayWeather): string {
  const emoji = weatherEmoji(day.conditionCode);
  const l = t(lang).weather;
  return `${emoji} ${l.tempRange(day.tempMin, day.tempMax)}`;
}
