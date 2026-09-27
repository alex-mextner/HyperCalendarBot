// src/services/location/location-verification-service.ts

import type { InlineKeyboard, TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { AgendaRepository } from '../../database/repositories/agenda.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, Invitation, InvitationStatus, User } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { formatInvitation } from '../event/formatters.ts';
import { formatAnsweredInvitationCard } from '../sharing/answered-invitation-card.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from '../sharing/invitation-rsvp-keyboard.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import { guessCountryFromTimezone, resolveTimezone } from '../timezone/timezone-service.ts';
import type { AddressCache } from './address-cache.ts';
import type { GeocodedLocation, GeocodingBias, GeocodingService } from './geocoding-service.ts';
import type { LocationCandidateStore } from './location-candidate-store.ts';

type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
type InvitationEditOptions = { parse_mode: ParseMode; reply_markup?: InlineKeyboard };
type RenderedInvitationCard = { text: string; options: InvitationEditOptions };
/** Statuses whose card is still on screen as the recipient last saw it */
type LiveInvitationStatus = Exclude<InvitationStatus, 'cancelled' | 'expired'>;

const logger = botLogger.child({ module: 'location-verification' });

/** A place farther than this from the user's home city is never resolved without asking. */
const NEAR_HOME_CITY_KM = 50;
const EARTH_RADIUS_KM = 6371;

/** Where the user's locations are expected when the text does not say otherwise. */
interface HomeArea {
  bias: GeocodingBias;
  /** Centre of the home city; null when only the home country is known. */
  cityCenter: { latitude: number; longitude: number } | null;
}

/** The country the user set in the profile, else the one implied by the timezone. */
function homeCountryCode(user: User): string | null {
  return user.country_code ?? guessCountryFromTimezone(user.timezone);
}

/**
 * Whether a place lies where the user lives: in the user's own timezone zone (these span borders,
 * e.g. Montenegro is in Europe/Belgrade) or in the home country.
 */
function isInUserRegion(
  user: User,
  place: { latitude: number; longitude: number; countryCode?: string | null },
): boolean {
  const homeCountry = homeCountryCode(user);
  return (
    resolveTimezone(place.latitude, place.longitude) === user.timezone ||
    (homeCountry !== null && place.countryCode === homeCountry)
  );
}

function isInsideHomeArea(geo: GeocodedLocation, home: HomeArea): boolean {
  if (home.cityCenter) {
    // Haversine great-circle distance.
    const toRad = Math.PI / 180;
    const dLat = (geo.latitude - home.cityCenter.latitude) * toRad;
    const dLng = (geo.longitude - home.cityCenter.longitude) * toRad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(home.cityCenter.latitude * toRad) * Math.cos(geo.latitude * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a)) <= NEAR_HOME_CITY_KM;
  }
  return home.bias.countryCode !== null && geo.countryCode === home.bias.countryCode;
}

/** Place label ("Venue — address") linked to the place on Google Maps. */
function placeLinkHtml(geo: GeocodedLocation): string {
  const label =
    geo.venueName && geo.venueName !== geo.formattedAddress
      ? `${geo.venueName} — ${geo.formattedAddress}`
      : geo.formattedAddress;
  return `<a href="${escapeHtml(geo.googleMapsUrl)}">${escapeHtml(label)}</a>`;
}

export interface LocationVerificationDeps {
  geocodingService: GeocodingService;
  addressCache: AddressCache;
  eventRepo: EventRepository;
  userRepo: UserRepository;
  invitationRepo: InvitationRepository;
  /** Invitee's view of the event roster on an answered invitation card */
  agendaRepository: AgendaRepository;
  /** Forecast line on an accepted invitation card; absent when weather is not configured */
  weatherService?: WeatherService;
  /** Temporary store for location candidates (Redis-backed with TTL) */
  candidateStore: LocationCandidateStore;
  /** Callback to send a message to a user (for confirmation/clarification) */
  sendMessage: (
    userId: number,
    text: string,
    options?: { parse_mode?: ParseMode; reply_markup?: ReplyMarkup },
  ) => Promise<void>;
  /** Callback to edit an existing invitation message; the edit replaces its inline keyboard with `reply_markup` */
  editMessage?: (chatId: number, messageId: number, text: string, options: InvitationEditOptions) => Promise<void>;
}

export interface LocationVerificationResult {
  resolved: boolean;
  geocoded: GeocodedLocation | null;
  cityExtracted: string | null;
  /** If multiple candidates found, returns them for user selection */
  candidates: GeocodedLocation[];
}

export class LocationVerificationService {
  constructor(private deps: LocationVerificationDeps) {}

  /**
   * Verify and resolve event location in the background.
   * Called after event creation if the event has a location field.
   *
   * Flow:
   * 1. Check address cache for a place the user confirmed earlier
   * 2. If not cached, geocode via Google Maps, biased toward the user's home area
   *    (home city when it lies in the user's timezone or home country, else the home country)
   * 3. A single result inside the home area → resolve the event, update sent invitations and tell
   *    the user which place was picked, with a "wrong place" button; a cache hit is announced the
   *    same way, so a wrongly remembered place can be rejected and forgotten
   * 4. Several results, or one outside the home area → ask the user to pick one or keep the text
   * 5. No results → tell the user
   * In cases 4 and 5 the event keeps only the typed text, unverified.
   *
   * Automatic resolution never writes the address cache or the user's city: a wrong guess would
   * otherwise bias every later lookup. Only an explicit confirmation (candidate button or a pin
   * shared for the event) does, see `cacheAndUpdateCity`.
   */
  async verifyEventLocation(event: CalendarEvent, user: User): Promise<LocationVerificationResult> {
    if (!event.location) {
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    const location = event.location.trim();
    if (location.length === 0) {
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    logger.info({ eventId: event.id, location, userId: user.telegram_id }, 'Starting location verification');

    // 1. Check address cache
    const cached = await this.deps.addressCache.findMapping(user.telegram_id, location);
    if (cached) {
      logger.info(
        { eventId: event.id, cached: cached.resolvedAddress, venue: cached.venueName ?? null },
        'Found cached address mapping',
      );
      const geoFromCache: GeocodedLocation = {
        formattedAddress: cached.resolvedAddress,
        latitude: cached.latitude,
        longitude: cached.longitude,
        city: null,
        country: null,
        placeId: cached.placeId,
        googleMapsUrl: cached.googleMapsUrl,
        venueName: cached.venueName ?? null,
      };
      await this.applyResolvedLocation(event, geoFromCache);
      await this.announceResolved(event, user, geoFromCache);
      return {
        resolved: true,
        geocoded: geoFromCache,
        cityExtracted: null,
        candidates: [],
      };
    }

    // 2. Geocode via Google Maps, biased toward the user's home area
    const home = await this.resolveHomeArea(user);

    // Try place search first (handles venue names better), fallback to geocoding
    let results = await this.deps.geocodingService.findPlace(location, home?.bias);
    if (results.length === 0) {
      results = await this.deps.geocodingService.geocodeAddress(location, home?.bias);
    }

    if (results.length === 0) {
      logger.info({ eventId: event.id, location }, 'No geocoding results found');
      await this.clearResolvedLocation(event);
      await this.notify(user, t(user.language).aiTools.location.locationNotFound(escapeHtml(event.title)));
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    // 3. Single result inside the home area → auto-resolve, and show the user what was picked
    const geo = results.length === 1 ? results[0] : undefined;
    if (geo && home && isInsideHomeArea(geo, home)) {
      await this.applyResolvedLocation(event, geo);
      await this.announceResolved(event, user, geo);
      return { resolved: true, geocoded: geo, cityExtracted: geo.city, candidates: [] };
    }

    // 4. Several candidates, or one outside the home area → ask the user to choose
    await this.clearResolvedLocation(event);
    await this.askUserToChoose(event, user, results);
    return {
      resolved: false,
      geocoded: null,
      cityExtracted: results[0]?.city ?? null,
      candidates: results,
    };
  }

  /** Apply resolved location to event and update invitations */
  async applyResolvedLocation(event: CalendarEvent, geo: GeocodedLocation): Promise<void> {
    const venueName = geo.venueName ?? null;
    // Update event in DB
    this.deps.eventRepo.updateLocationFields(event.id, {
      resolved_address: geo.formattedAddress,
      latitude: geo.latitude,
      longitude: geo.longitude,
      google_maps_url: geo.googleMapsUrl,
      location_verified: 1,
      venue_name: venueName,
    });

    logger.info({ eventId: event.id, resolvedAddress: geo.formattedAddress, venueName }, 'Event location resolved');

    // Build the updated event in-memory (avoids re-fetching from DB just to get the new fields)
    const updatedEvent: CalendarEvent = {
      ...event,
      resolved_address: geo.formattedAddress,
      latitude: geo.latitude,
      longitude: geo.longitude,
      google_maps_url: geo.googleMapsUrl,
      location_verified: 1,
      venue_name: venueName,
    };

    // Update invitation messages
    await this.updateInvitationMessages(updatedEvent);
  }

  /** Handle user selecting a location from candidates */
  async handleLocationChoice(
    eventId: number,
    userId: number,
    choiceIndex: number,
    candidates: GeocodedLocation[],
  ): Promise<boolean> {
    const event = this.deps.eventRepo.findById(eventId, userId);
    if (!event) return false;

    const chosen = candidates[choiceIndex];
    if (!chosen) return false;

    const user = this.deps.userRepo.findByTelegramId(userId);
    if (!user) return false;

    await this.applyResolvedLocation(event, chosen);
    await this.cacheAndUpdateCity(user, event.location ?? '', chosen);

    // Clean up stored candidates after successful choice
    await this.deps.candidateStore.del(eventId).catch((err) => {
      logger.warn({ err, eventId }, 'Failed to delete location candidates from store');
    });

    return true;
  }

  /** Retrieve stored candidates for a given event (from Redis) */
  async getStoredCandidates(eventId: number): Promise<GeocodedLocation[] | null> {
    return this.deps.candidateStore.get(eventId);
  }

  /** Reverse geocode coordinates to extract city. Used by callback handler to avoid ad-hoc service creation. */
  async reverseGeocodeForCity(lat: number, lng: number): Promise<{ city: string } | null> {
    const result = await this.deps.geocodingService.reverseGeocode(lat, lng);
    if (!result?.city) return null;
    return { city: result.city };
  }

  /** Resolve location from coordinates (when user sends 📍 for an event) */
  async resolveFromCoordinates(eventId: number, lat: number, lng: number, userId: number): Promise<boolean> {
    // Verify user has access to the event before doing any work
    const event = this.deps.eventRepo.findById(eventId, userId);
    if (!event) return false;

    const geo = await this.deps.geocodingService.reverseGeocode(lat, lng);
    if (!geo) return false;

    const user = this.deps.userRepo.findByTelegramId(userId);
    if (!user) return false;

    await this.applyResolvedLocation(event, geo);
    if (event.location) {
      await this.cacheAndUpdateCity(user, event.location, geo);
    }
    return true;
  }

  /**
   * The user keeps the typed location (declined the candidates or the auto-picked place): the event
   * loses any resolved place and stays unverified, the offered candidates are dropped, and a
   * remembered place for this text is forgotten so it is not applied again.
   */
  async keepTypedLocation(eventId: number, userId: number): Promise<CalendarEvent | null> {
    const event = this.deps.eventRepo.findById(eventId, userId);
    if (!event) return null;

    await this.clearResolvedLocation(event);
    await this.deps.candidateStore.del(eventId).catch((err) => {
      logger.warn({ err, eventId }, 'Failed to delete location candidates from store');
    });
    if (event.location) {
      await this.deps.addressCache.forgetMapping(userId, event.location).catch((err) => {
        logger.warn({ err, eventId, userId }, 'Failed to forget rejected address mapping');
      });
    }
    return event;
  }

  /**
   * Learn from a location the user explicitly confirmed (candidate button or a pin shared for the
   * event): remember the typed text → place mapping, and fill an empty home city, but only with a
   * place in the user's region, so a venue abroad never becomes the home city.
   * Never called for automatic resolution.
   */
  private async cacheAndUpdateCity(user: User, inputLocation: string, geo: GeocodedLocation): Promise<void> {
    // Cache the mapping
    await this.deps.addressCache.recordMapping(user.telegram_id, inputLocation, {
      resolvedAddress: geo.formattedAddress,
      googleMapsUrl: geo.googleMapsUrl,
      latitude: geo.latitude,
      longitude: geo.longitude,
      placeId: geo.placeId,
      venueName: geo.venueName,
    });

    if (!user.city && geo.city && isInUserRegion(user, geo)) {
      this.deps.userRepo.update(user.telegram_id, { city: geo.city });
      logger.info({ userId: user.telegram_id, city: geo.city }, 'User city set from confirmed location');
    }
  }

  /**
   * The home city anchors searches only when it lies in the user's region: a city learned from a
   * wrong guess must not pull every later search toward it.
   */
  private async resolveHomeArea(user: User): Promise<HomeArea | null> {
    const countryCode = homeCountryCode(user);
    if (user.city) {
      const city = await this.deps.geocodingService.locateArea({ city: user.city, countryCode });
      if (city && isInUserRegion(user, city)) {
        return {
          bias: { countryCode: city.countryCode, bounds: city.bounds },
          cityCenter: { latitude: city.latitude, longitude: city.longitude },
        };
      }
      logger.warn(
        { userId: user.telegram_id, countryCode, cityCountryCode: city?.countryCode ?? null },
        'Home city is outside the user timezone and home country; biasing geocoding by country only',
      );
    }
    if (!countryCode) return null;

    const country = await this.deps.geocodingService.locateArea({ city: null, countryCode });
    return { bias: { countryCode, bounds: country?.bounds ?? null }, cityCenter: null };
  }

  /** Drop a resolved place that does not belong to the event's current text, and refresh invitations. */
  private async clearResolvedLocation(event: CalendarEvent): Promise<void> {
    if (event.location_verified === 0 && event.resolved_address === null) return;

    this.deps.eventRepo.clearLocationFields(event.id);
    logger.info({ eventId: event.id }, 'Event location reset to typed text');
    await this.updateInvitationMessages({
      ...event,
      resolved_address: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });
  }

  /** Tell the user which place was applied, with a button to reject it. */
  private async announceResolved(event: CalendarEvent, user: User, geo: GeocodedLocation): Promise<void> {
    const msgs = t(user.language).aiTools.location;
    await this.notify(user, msgs.locationResolved(escapeHtml(event.title), placeLinkHtml(geo)), [
      [{ text: msgs.wrongPlace, callback_data: `${CB.LOCATION_CANDIDATE}:${event.id}:keep` }],
    ]);
  }

  private async notify(
    user: User,
    text: string,
    inlineKeyboard?: TelegramInlineKeyboardMarkup['inline_keyboard'],
  ): Promise<void> {
    try {
      await this.deps.sendMessage(user.telegram_id, text, {
        parse_mode: 'HTML',
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      });
    } catch (err) {
      logger.error({ err, userId: user.telegram_id }, 'Failed to send location message');
    }
  }

  private async askUserToChoose(event: CalendarEvent, user: User, candidates: GeocodedLocation[]): Promise<void> {
    const msgs = t(user.language).aiTools.location;

    const limited = candidates.slice(0, 5);
    const options = limited.map((c, i) => `${i + 1}. ${placeLinkHtml(c)}`);
    const text = `${msgs.clarifyAddress(escapeHtml(event.title))}\n\n${options.join('\n')}`;

    // Persist candidates in Redis so the callback handler can retrieve them
    await this.deps.candidateStore.set(event.id, limited).catch((err) => {
      logger.error({ err, eventId: event.id }, 'Failed to store location candidates');
    });

    // One row per place, labelled with its name; the numbers match the linked list above
    const rows = limited.map((c, i) => [
      {
        text: `${i + 1}. ${c.venueName ?? c.formattedAddress}`,
        callback_data: `${CB.LOCATION_CANDIDATE}:${event.id}:${i}`,
      },
    ]);

    await this.notify(user, text, [
      ...rows,
      [{ text: msgs.noneOfThese, callback_data: `${CB.LOCATION_CANDIDATE}:${event.id}:keep` }],
    ]);
  }

  /**
   * Re-render every delivered invitation card with the resolved location, in the form its recipient
   * last saw. A Telegram text edit without reply_markup deletes the inline keyboard, so actionable cards
   * send theirs again: a group card keeps Going/Not going for every member (a group invitation stays
   * pending; members answer through event_participants), a pending personal card keeps its RSVP keyboard,
   * and an answered card (accepted, maybe, declined) keeps the answer line and event detail the RSVP
   * callback left, without buttons. Cancelled and expired cards are left as they are, and so is a pending
   * card whose invitee proposed another time: a free-text proposal already replaced it with the
   * proposal-sent notice, and the inviter's keep/reschedule answer settles it.
   */
  private async updateInvitationMessages(event: CalendarEvent): Promise<void> {
    const editMessage = this.deps.editMessage;
    if (!editMessage) return;

    for (const inv of this.deps.invitationRepo.getByEvent(event.id)) {
      if (!inv.message_id || !inv.chat_id || inv.status === 'cancelled' || inv.status === 'expired') continue;
      if (inv.status === 'pending' && inv.proposed_time) continue;

      try {
        const card = await this.renderInvitationCard(event, inv, inv.status);
        // Earlier edits in this loop yield, and an invitee can answer or propose a time meanwhile: that
        // callback has then already rewritten the card, so a stale render must not overwrite it.
        const current = this.deps.invitationRepo.findById(inv.id);
        if (current?.status !== inv.status || current.proposed_time !== inv.proposed_time) continue;
        await editMessage(inv.chat_id, inv.message_id, card.text, card.options);
      } catch (err) {
        logger.warn(
          { err, invitationId: inv.id, eventId: event.id },
          'Failed to update invitation message after location resolution',
        );
      }
    }
  }

  private async renderInvitationCard(
    event: CalendarEvent,
    inv: Invitation,
    status: LiveInvitationStatus,
  ): Promise<RenderedInvitationCard> {
    const inviter = this.deps.userRepo.findByTelegramId(inv.inviter_id);
    const inviterName = inviter?.first_name ?? inviter?.username ?? 'User';

    if (inv.invitee_id < 0) {
      const groupLang = inviter?.language ?? 'en';
      const text = formatInvitation(
        event,
        event.timezone,
        groupLang,
        inviterName,
        inv.inviter_id,
        inviter?.username,
        null,
        false,
      );
      return { text, options: { parse_mode: 'HTML', reply_markup: groupRsvpKeyboard(event.id, groupLang) } };
    }

    const invitee = this.deps.userRepo.findByTelegramId(inv.invitee_id);
    const inviteeLang = invitee?.language ?? 'en';

    if (status === 'pending') {
      const text = formatInvitation(
        event,
        event.timezone,
        inviteeLang,
        inviterName,
        inv.inviter_id,
        inviter?.username,
        invitee?.timezone,
        invitee?.onboarding_completed === 1,
      );
      return { text, options: { parse_mode: 'HTML', reply_markup: invitationRsvpKeyboard(inv.id, inviteeLang) } };
    }

    const text = await formatAnsweredInvitationCard(
      status,
      event,
      { userId: inv.invitee_id, language: inviteeLang, timezone: invitee?.timezone ?? event.timezone },
      { agendaRepository: this.deps.agendaRepository, weatherService: this.deps.weatherService },
    );
    return { text, options: { parse_mode: 'HTML' } };
  }
}
