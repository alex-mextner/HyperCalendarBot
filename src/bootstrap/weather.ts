// src/bootstrap/weather.ts
//
// Startup phase: the optional weather service (requires OPENWEATHER_API_KEY).
//
// Ordering invariant: it runs after the voice-call phase and before the notification scheduler, the
// invitation cards and location verification, which all take the service as an input. The module is
// imported lazily (runtime-selected by configuration) so deployments without a key never load it.

import type { EnvConfig } from '../config/env.ts';
import type { WeatherService } from '../services/weather/weather-service.ts';
import { botLogger } from '../utils/logger.ts';

export async function initWeatherService(
  config: Pick<EnvConfig, 'OPENWEATHER_API_KEY'>,
): Promise<WeatherService | undefined> {
  if (!config.OPENWEATHER_API_KEY) return undefined;
  const { WeatherService: WeatherServiceClass } = await import('../services/weather/weather-service.ts');
  const service = new WeatherServiceClass({ apiKey: config.OPENWEATHER_API_KEY });
  botLogger.info('Weather service initialized');
  return service;
}
