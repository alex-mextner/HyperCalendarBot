// src/bootstrap/location.ts
//
// Startup phase: location verification (geocoding + address cache + pending shared locations).
//
// Ordering invariants:
//  - Requires GOOGLE_API_KEY and REDIS_URL (the address cache is Redis-only). With a key but no
//    Redis it logs why the feature is off; with no key it stays silent.
//  - It runs after the Google sync phase (it re-pushes Google copies of an event through the
//    scheduler that phase produced) and before createBot(), which takes the three stores as inputs.
//  - Message sending resolves `ctx.botRef` at call time (patched after createBot()).
//  - Modules are imported lazily (runtime-selected by configuration).

import { AgendaRepository } from '../database/repositories/agenda.repository.ts';
import type { CalendarEvent } from '../database/types.ts';
import type { AddressCache } from '../services/location/address-cache.ts';
import type { LocationVerificationService } from '../services/location/location-verification-service.ts';
import type { PendingGeoStore } from '../services/location/pending-geo-store.ts';
import type { WeatherService } from '../services/weather/weather-service.ts';
import { botLogger } from '../utils/logger.ts';
import { setWithOptionalExpiry } from './redis-adapters.ts';
import type { StartupContext } from './runtime.ts';

export interface LocationServices {
  locationVerification?: LocationVerificationService;
  addressCache?: AddressCache;
  pendingGeoStore?: PendingGeoStore;
}

export interface LocationInputs {
  weatherService: WeatherService | undefined;
  pushEventCopies: ((event: CalendarEvent) => Promise<void>) | undefined;
}

/** A keep tap re-renders every card; an unchanged card is already what the user sees. */
export function isMessageNotModified(err: unknown): boolean {
  return String(err).includes('message is not modified');
}

type RedisEval = (script: string, numkeys: number, ...keysAndArgs: string[]) => Promise<unknown>;

async function buildLocationServices(
  ctx: StartupContext,
  inputs: LocationInputs,
  googleApiKey: string,
  redisUrl: string,
): Promise<Required<LocationServices>> {
  const { db, botRef } = ctx;
  const { createGeocodingService } = await import('../services/location/geocoding-service.ts');
  const { withCachedAreas } = await import('../services/location/area-cache.ts');
  const { AddressCache: AddressCacheClass, redisCompareAndSet } = await import('../services/location/address-cache.ts');
  const { LocationVerificationService: VerificationService } = await import(
    '../services/location/location-verification-service.ts'
  );
  const { RedisLocationCandidateStore } = await import('../services/location/location-candidate-store.ts');
  const { RedisPendingGeoStore } = await import('../services/location/pending-geo-store.ts');

  const locationRedis = new Bun.RedisClient(redisUrl);
  const redisEval: RedisEval = (script, numkeys, ...keysAndArgs) => locationRedis.eval(script, numkeys, ...keysAndArgs);
  const geocodingService = withCachedAreas(createGeocodingService(googleApiKey), {
    get: (key: string) => locationRedis.get(key),
    set: (key: string, value: string, opts: { ex: number }) => locationRedis.set(key, value, 'EX', opts.ex),
  });
  const addressCache = new AddressCacheClass({
    get: (key: string) => locationRedis.get(key),
    compareAndSet: redisCompareAndSet({ eval: redisEval }),
  });
  const candidateStore = new RedisLocationCandidateStore({
    set: (key: string, value: string, opts?: { ex?: number }) => setWithOptionalExpiry(locationRedis, key, value, opts),
    del: (key: string) => locationRedis.del(key),
    eval: redisEval,
  });

  // sendMessage / editMessage closures resolve botRef at call time (patched after createBot)
  const locationVerification = new VerificationService({
    geocodingService,
    addressCache,
    eventRepo: db.events,
    userRepo: db.users,
    invitationRepo: db.invitations,
    agendaRepository: new AgendaRepository(db.db),
    weatherService: inputs.weatherService,
    candidateStore,
    sendMessage: async (userId, text, options) => {
      await botRef.sendMessage(userId, text, options?.parse_mode, options?.reply_markup).catch((err: unknown) => {
        botLogger.error({ err, userId }, 'Location verification: failed to send message');
      });
    },
    editMessage: async (chatId, messageId, text, options) => {
      await botRef
        .editMessage(chatId, messageId, text, options.parse_mode, options.reply_markup)
        .catch((err: unknown) => {
          if (isMessageNotModified(err)) return;
          botLogger.error({ err, chatId, messageId }, 'Location verification: failed to edit message');
        });
    },
    pushGoogleCopies: inputs.pushEventCopies,
  });

  const pendingGeoStore = new RedisPendingGeoStore({
    set: (key: string, value: string, opts?: { ex?: number }) => setWithOptionalExpiry(locationRedis, key, value, opts),
    get: (key: string) => locationRedis.get(key),
    del: (key: string) => locationRedis.del(key),
  });

  return { locationVerification, addressCache, pendingGeoStore };
}

export async function initLocationVerification(ctx: StartupContext, inputs: LocationInputs): Promise<LocationServices> {
  const { config } = ctx;
  if (config.GOOGLE_API_KEY && config.REDIS_URL) {
    const services = await buildLocationServices(ctx, inputs, config.GOOGLE_API_KEY, config.REDIS_URL);
    botLogger.info('Location verification initialized (Google Maps + Redis)');
    return services;
  }
  if (config.GOOGLE_API_KEY) {
    botLogger.info('Location verification disabled: REDIS_URL not set (address cache requires Redis)');
  }
  return {};
}
