// src/services/weather/format.ts
import type { Lang } from '../../config/constants.ts';
import { t } from '../../config/constants.ts';
import type { DayWeather } from './types.ts';
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

/** Format weather for weekly digest — one compact line per day */
export function formatWeekWeatherLine(lang: Lang, day: DayWeather): string {
  const emoji = weatherEmoji(day.conditionCode);
  const l = t(lang).weather;
  return `${emoji} ${l.tempRange(day.tempMin, day.tempMax)}`;
}
