// src/bot/handlers/callback/location-routes.ts
// Event location callbacks: geolocation pin handling, place candidates and the map button.

import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { UserRepository } from '../../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../../database/types.ts';
import { eventVenue } from '../../../services/location/event-venue.ts';
import { formatLocationHtml } from '../../../services/location/format-location.ts';
import type { LocationVerificationService } from '../../../services/location/location-verification-service.ts';
import type { PendingGeoStore } from '../../../services/location/pending-geo-store.ts';
import { resolveTimezone } from '../../../services/timezone/timezone-service.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { escapeHtml, formatUtcOffset } from '../../../utils/telegram.ts';
import type { BotCallbackContext } from '../../types.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

interface LocationLabels {
  keptAsTyped: (title: string, location: string) => string;
  locationChoiceOutdated: string;
}

export function registerLocationRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService } = deps;
  const { eventRepo, userRepo, invitationRepo, locationVerification, pendingGeoStore } = deps.opts;

  /** The confirmation edited into the picker or pin message: the title and the resolved place, linked. */
  function locationResolvedHtml(lang: Lang, eventId: number, userId: number): string {
    const event = eventRepo?.findById(eventId, userId);
    const place = event ? formatLocationHtml(event) : '';
    return t(lang).aiTools.location.locationResolved(escapeHtml(event?.title ?? ''), place);
  }

  async function resolveGeoPin(
    ctx: BotCallbackContext,
    user: User,
    lang: Lang,
    eventIdPart: string | undefined,
    verification: LocationVerificationService,
    geoStore: PendingGeoStore,
  ): Promise<void> {
    const eventId = Number.parseInt(eventIdPart ?? '', 10);
    if (Number.isNaN(eventId)) return;

    const errorText = t(lang).callbackErrors.error;
    const geo = await geoStore.get(user.telegram_id);
    if (!geo) {
      await ctx.editText(errorText, { reply_markup: undefined });
      return;
    }

    const success = await verification.resolveFromSharedLocation(eventId, geo, user.telegram_id);
    await geoStore.delete(user.telegram_id);

    if (success) {
      await ctx.editText(locationResolvedHtml(lang, eventId, user.telegram_id), {
        parse_mode: 'HTML',
        reply_markup: undefined,
      });
    } else {
      await ctx.editText(errorText, { reply_markup: undefined });
    }
  }

  async function applyCityTimezone(
    ctx: BotCallbackContext,
    user: User,
    lang: Lang,
    parts: string[],
    verification: LocationVerificationService,
    geoStore: PendingGeoStore,
    users: UserRepository,
  ): Promise<void> {
    const lat = Number.parseFloat(parts[2] ?? '');
    const lng = Number.parseFloat(parts[3] ?? '');
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    await geoStore.delete(user.telegram_id);

    const tz = resolveTimezone(lat, lng);
    const offset = formatUtcOffset(tz);
    const tzChanged = tz !== user.timezone;
    if (tzChanged) {
      users.update(user.telegram_id, { timezone: tz });
    }

    const reverseResult = await verification.reverseGeocodeForCity(lat, lng);
    if (reverseResult?.city) {
      users.update(user.telegram_id, { city: reverseResult.city });
    }

    const msgs = t(lang);
    await ctx.editText(tzChanged ? msgs.geo_tz_updated(tz, offset) : msgs.tz_same_from_location(tz, offset), {
      reply_markup: undefined,
    });
  }

  async function keepTypedPlace(
    ctx: BotCallbackContext,
    user: User,
    eventId: number,
    pickerId: string,
    labels: LocationLabels,
    verification: LocationVerificationService,
  ): Promise<void> {
    const kept = await verification.keepTypedLocation(eventId, user.telegram_id, pickerId);
    await ctx.editText(kept ? labels.keptAsTyped(kept.title, kept.location ?? '') : labels.locationChoiceOutdated, {
      reply_markup: undefined,
    });
  }

  async function showChosenPlace(ctx: BotCallbackContext, user: User, lang: Lang, eventId: number): Promise<void> {
    await ctx.editText(locationResolvedHtml(lang, eventId, user.telegram_id), {
      parse_mode: 'HTML',
      reply_markup: undefined,
    });
    // The creator chose from text and links: show the chosen point on Telegram's map once. The
    // picker itself keeps map links; a venue per candidate would flood the chat.
    const event = eventService.getEvent(eventId, user.telegram_id);
    const venue = event ? eventVenue(event) : null;
    if (venue) {
      await ctx.sendVenue(venue).catch((err: unknown) => {
        cmdLogger.warn({ err, eventId, userId: user.telegram_id }, 'Failed to send the chosen place as a venue');
      });
    }
  }

  // Location geo: user chose what to do with a geolocation pin (geo/city/other)
  dispatch.set(CB.LOCATION_GEO, async (ctx, _payload, parts, user) => {
    await ctx.answer();
    const lang = (user.language ?? 'en') as Lang;
    const msgs = t(lang);

    if (!locationVerification || !userRepo || !pendingGeoStore) return;

    const action = parts[1]; // 'geo', 'city', 'other'

    if (action === 'geo') {
      await resolveGeoPin(ctx, user, lang, parts[2], locationVerification, pendingGeoStore);
    } else if (action === 'city') {
      await applyCityTimezone(ctx, user, lang, parts, locationVerification, pendingGeoStore, userRepo);
    } else if (action === 'other') {
      // Keep the pin in store — AI will see it via system prompt and can attach it
      // to any event the user names in chat. The pin auto-expires in 30 minutes.
      await ctx.editText(msgs.aiTools.location.geoOtherAck, { reply_markup: undefined });
    }
  });

  // Location candidate: `loc_cand:<eventId>:<pickerId>:<index|keep>` — the creator picked a place or kept the typed text
  dispatch.set(CB.LOCATION_CANDIDATE, async (ctx, _payload, parts, user) => {
    await ctx.answer();
    const lang = (user.language ?? 'en') as Lang;
    const msgs = t(lang);

    if (!locationVerification) return;

    const eventId = Number.parseInt(parts[1] ?? '', 10);
    if (Number.isNaN(eventId)) return;
    const pickerId = parts[2] ?? '';
    const choice = parts[3];

    if (choice === 'keep') {
      await keepTypedPlace(ctx, user, eventId, pickerId, msgs.aiTools.location, locationVerification);
      return;
    }

    const choiceIndex = Number.parseInt(choice ?? '', 10);
    const resolved =
      !Number.isNaN(choiceIndex) &&
      (await locationVerification.handleLocationChoice(eventId, user.telegram_id, pickerId, choiceIndex));

    if (resolved) {
      await showChosenPlace(ctx, user, lang, eventId);
    } else {
      cmdLogger.warn({ eventId, userId: user.telegram_id }, 'Location picker is outdated or its event is gone');
      await ctx.editText(msgs.aiTools.location.locationChoiceOutdated, { reply_markup: undefined });
    }
  });

  /**
   * The event behind a Map button, if the presser may see it: their own or group-visible event, or
   * an event their personal invitation (or, in a group chat, the group's invitation) points to.
   */
  function eventForMap(eventId: number, userId: number, chatId: number | undefined): CalendarEvent | null {
    const visible = eventService.getEvent(eventId, userId);
    if (visible) return visible;
    const invitation =
      invitationRepo?.findActiveOrRespondedByEventAndInvitee(eventId, userId) ??
      (chatId !== undefined && chatId < 0
        ? invitationRepo?.findActiveOrRespondedByEventAndInvitee(eventId, chatId)
        : null);
    return invitation ? eventService.getEvent(eventId, invitation.inviter_id) : null;
  }

  // Map button: `ev_map:<eventId>` — send the event's confirmed place as a native Telegram venue
  dispatch.set(CB.EVENT_MAP, async (ctx, payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    const eventId = Number.parseInt(payload, 10);
    const event = Number.isNaN(eventId) ? null : eventForMap(eventId, user.telegram_id, ctx.chatId);
    const venue = event ? eventVenue(event) : null;
    if (!venue) {
      await ctx.answer({ text: t(lang).callbackErrors.notFound });
      return;
    }
    await ctx.answer();
    await ctx.sendVenue(venue).catch((err: unknown) => {
      cmdLogger.warn({ err, eventId, userId: user.telegram_id }, 'Failed to send the event place as a venue');
    });
  });
}
