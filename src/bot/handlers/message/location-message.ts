// src/bot/handlers/message/location-message.ts
// Private-chat location pins: offer the pin to a recent unverified event, else offer a timezone update.

import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import { resolveTimezone } from '../../../services/timezone/timezone-service.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { escapeHtml, formatUtcOffset } from '../../../utils/telegram.ts';
import type { BotCommandContext } from '../../types.ts';
import type { MessageHandlerDeps } from './types.ts';

const RECENT_EVENT_WINDOW_MS = 30 * 60 * 1000;

type SharedLocation = NonNullable<BotCommandContext['location']>;

async function persistPendingGeo(ctx: BotCommandContext, user: User, deps: MessageHandlerDeps): Promise<void> {
  if (!deps.pendingGeoStore || !ctx.location) return;
  const { latitude, longitude } = ctx.location;
  const venue = ctx.venue;
  await deps.pendingGeoStore
    .set(user.telegram_id, {
      latitude,
      longitude,
      venue: venue ? { title: venue.title, address: venue.address, googlePlaceId: venue.googlePlaceId ?? null } : null,
    })
    .catch((err) => cmdLogger.warn({ err, userId: user.telegram_id }, 'Failed to persist pending geo'));
}

/** Asks whether the pin belongs to the event the user created in the last half hour; true when asked. */
async function offerPinForRecentEvent(
  ctx: BotCommandContext,
  user: User,
  location: SharedLocation,
  deps: MessageHandlerDeps,
): Promise<boolean> {
  const latestEvent = deps.eventService.getLatestCreated(user.telegram_id);
  const isRecentUnverified =
    latestEvent?.location &&
    !latestEvent.location_verified &&
    Date.now() - new Date(latestEvent.created_at).getTime() < RECENT_EVENT_WINDOW_MS;
  if (!latestEvent || !isRecentUnverified || !deps.locationVerification || !deps.pendingGeoStore) return false;

  const { latitude, longitude } = location;
  const msgs = t(user.language);
  const kb = new InlineKeyboard()
    .text(msgs.aiTools.location.geoForEventConfirm, `${CB.LOCATION_GEO}:geo:${latestEvent.id}`)
    .row()
    .text(msgs.aiTools.location.geoNewLocation, `${CB.LOCATION_GEO}:city:${latitude}:${longitude}`)
    .row()
    .text(msgs.aiTools.location.geoExplain, `${CB.LOCATION_GEO}:other:${latitude}:${longitude}`);
  await ctx.send(msgs.aiTools.location.geoForEvent(escapeHtml(latestEvent.title)), {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
  return true;
}

async function offerTimezoneUpdate(ctx: BotCommandContext, user: User, location: SharedLocation): Promise<void> {
  const msgs = t(user.language);
  const tz = resolveTimezone(location.latitude, location.longitude);
  const offset = formatUtcOffset(tz);
  if (tz === user.timezone) {
    await ctx.send(msgs.tz_same_from_location(tz, offset));
    return;
  }
  const kb = new InlineKeyboard()
    .text(msgs.geo_tz_confirm_btn, `${CB.GEO_TZ_CONFIRM}:${tz}`)
    .text(msgs.geo_tz_dismiss_btn, CB.GEO_TZ_DISMISS);
  await ctx.send(msgs.geo_tz_confirm_prompt(user.timezone, tz, offset), { parse_mode: 'HTML', reply_markup: kb });
}

/**
 * Location message in a private chat → context-aware handling. A venue picked in Telegram's place
 * search also carries its location; its name and address are kept with it.
 */
export async function handlePrivateLocation(
  ctx: BotCommandContext,
  user: User,
  location: SharedLocation,
  deps: MessageHandlerDeps,
): Promise<void> {
  // ALWAYS persist the pin so the AI can read it from system prompt and
  // attach it to any event the user mentions next. Auto-expires in 30 min.
  await persistPendingGeo(ctx, user, deps);
  if (await offerPinForRecentEvent(ctx, user, location, deps)) return;
  // Default behavior: timezone update (pin already stored above — AI can use it)
  await offerTimezoneUpdate(ctx, user, location);
}
