// src/services/location/location-verification-service.ts

import type { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { AgendaRepository } from '../../database/repositories/agenda.repository.ts';
import { type EventRepository, UNRESOLVED_PLACE } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { type InvitationEditOptions, refreshInvitationCards } from '../sharing/invitation-cards.ts';
import { guessCountryFromTimezone, resolveTimezone } from '../timezone/timezone-service.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import type { AddressCache } from './address-cache.ts';
import { formatLocationHtml, formatLocationPlain } from './format-location.ts';
import {
  buildGoogleMapsUrl,
  type GeocodedLocation,
  type GeocodingBias,
  type GeocodingService,
} from './geocoding-service.ts';
import type { LocationCandidateStore, LocationPicker } from './location-candidate-store.ts';
import type { SharedLocation } from './pending-geo-store.ts';

type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;

const logger = botLogger.child({ module: 'location-verification' });

/** Places offered in one picker. */
const MAX_CANDIDATES = 5;

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
  /** Re-pushes the event's Google Calendar copies (owner and participants); absent without Google sync */
  pushGoogleCopies?: (event: CalendarEvent) => Promise<void>;
}

export interface LocationVerificationResult {
  /** Always false: verification only asks; the creator's tap resolves the event. */
  resolved: boolean;
  /** Always null, see `resolved`. */
  geocoded: GeocodedLocation | null;
  cityExtracted: string | null;
  /** The places offered to the creator; empty when nothing was found. */
  candidates: GeocodedLocation[];
}

export class LocationVerificationService {
  constructor(private deps: LocationVerificationDeps) {}

  /**
   * Ask the creator which place the event's typed location means. Runs in the background after an
   * event gets a concrete location.
   *
   * The bot always asks: nothing is applied before the creator taps a candidate. The event keeps
   * only the typed text, unverified: no venue, address or map link is written (a place confirmed
   * for an earlier text is dropped, Google copies showing it are re-pushed and delivered invitation
   * cards showing it are re-rendered with the typed text), and neither the address cache nor
   * `users.city` is touched. The previous picker of the event is closed.
   *
   * Flow:
   * 1. A place the creator confirmed earlier for this text (address cache) is the candidate; no
   *    new search is made.
   * 2. Otherwise geocode via Google Maps, biased toward the creator's home area: the home city
   *    when it lies in the creator's timezone or home country, else the home country
   *    (`users.country_code`, else the one implied by the timezone).
   * 3. If the event's text changed during the search, stop: the newer text has its own
   *    verification, and this one must not replace its picker.
   * 4. Candidates found → one message: each place with its map link and a button named after it,
   *    plus "none of these — keep as typed". `handleLocationChoice` / `keepTypedLocation` handle
   *    the taps.
   * 5. No candidates → tell the creator to send a pin or the full address.
   */
  async verifyEventLocation(event: CalendarEvent, user: User): Promise<LocationVerificationResult> {
    const canSeeEvent = this.deps.eventRepo.findById(event.id, user.telegram_id) !== null;
    if (canSeeEvent) {
      // A new verification supersedes the previous picker: a tap on it must not apply a place
      // chosen for an earlier text
      await this.deps.candidateStore.del(event.id).catch((err) => {
        logger.warn({ err, eventId: event.id }, 'Failed to delete location candidates from store');
      });
    }
    const typed = event.location;
    if (!typed) {
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    const location = typed.trim();
    if (location.length === 0) {
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    // Until the creator answers, the event holds only the typed text: a place confirmed for an
    // earlier text must not stay on it, whoever changed the text, nor on the invitation cards. The
    // cards are re-rendered from the stored row, so a time or title edited during the awaits here is
    // not rolled back, and only while it still holds this text unconfirmed: an edit of the text, or a
    // place confirmed after the drop, re-renders them itself (best effort: renders already in
    // flight are not ordered, #678).
    await this.dropResolvedPlace(event);
    const stored = this.deps.eventRepo.findByIdUnfiltered(event.id);
    if (stored?.location === typed && stored.location_verified === 0) {
      await this.refreshInvitationCards(event, { ...event, ...stored, ...UNRESOLVED_PLACE });
    }

    // Only a user who can see the event is asked. A secretary updating the owner's event could not
    // answer the picker (#421), so no search is made and the owner's open picker stays.
    if (!canSeeEvent) {
      logger.info({ eventId: event.id, userId: user.telegram_id }, 'User cannot see the event; not asking');
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    logger.info({ eventId: event.id, location, userId: user.telegram_id }, 'Starting location verification');

    const { candidates, remembered } = await this.findCandidates(event, user, location);

    // The event changed while the search ran: its text (a newer text starts its own verification,
    // which may already have stored its picker), or it was deleted, or a pin confirmed a place
    // (this verification cleared any earlier one). Asking now would replace the newer question or
    // let a keep tap erase the pin. No await may come between this check and the picker's `set` in
    // `askUserToChoose`.
    const current = this.deps.eventRepo.findById(event.id, user.telegram_id);
    if (current?.location !== typed || current.location_verified !== 0) {
      logger.info({ eventId: event.id }, 'Event location changed or was confirmed during verification; not asking');
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    if (candidates.length === 0) {
      logger.info({ eventId: event.id, location }, 'No geocoding results found');
      await this.notify(user, t(user.language).aiTools.location.locationNotFound(escapeHtml(event.title)));
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    await this.askUserToChoose(event, user, { location: typed, candidates, remembered });
    return { resolved: false, geocoded: null, cityExtracted: candidates[0]?.city ?? null, candidates };
  }

  /**
   * The event's location changed from `before` to `after` without a place being confirmed: an edit
   * (a new text, an abstract place, a removal) or a question that dropped the confirmed place.
   * Re-render the delivered invitation cards when their location line changes, so no card keeps a
   * place the event no longer has, whether or not a question follows or finds anything.
   */
  async refreshInvitationCards(before: CalendarEvent, after: CalendarEvent): Promise<void> {
    if (formatLocationHtml(before) === formatLocationHtml(after)) return;
    // Never rejects: a card that cannot be re-rendered must not fail the edit or stop the question
    await this.updateInvitationMessages(after).catch((err) => {
      logger.error({ err, eventId: after.id }, 'Failed to re-render invitation cards after the location change');
    });
  }

  /** The remembered place for this text, else the places a search biased to the home area finds. */
  private async findCandidates(
    event: CalendarEvent,
    user: User,
    location: string,
  ): Promise<Pick<LocationPicker, 'candidates' | 'remembered'>> {
    const cached = await this.deps.addressCache.findMapping(user.telegram_id, location);
    if (cached) {
      logger.info(
        { eventId: event.id, cached: cached.resolvedAddress, venue: cached.venueName ?? null },
        'Offering the remembered place for this location',
      );
      const place: GeocodedLocation = {
        formattedAddress: cached.resolvedAddress,
        latitude: cached.latitude,
        longitude: cached.longitude,
        city: null,
        country: null,
        placeId: cached.placeId,
        googleMapsUrl: cached.googleMapsUrl,
        venueName: cached.venueName ?? null,
      };
      return { candidates: [place], remembered: true };
    }

    const bias = await this.homeAreaBias(user);
    // Place search handles venue names better; plain geocoding is the fallback
    const places = await this.deps.geocodingService.findPlace(location, bias);
    const candidates = places.length > 0 ? places : await this.deps.geocodingService.geocodeAddress(location, bias);
    return { candidates, remembered: false };
  }

  /**
   * Apply the place the creator confirmed (candidate tap or pin), then re-push the Google copies
   * and update delivered invitations.
   */
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

    await this.pushGoogleCopiesIfShownPlaceChanged(event, updatedEvent);
    // Update invitation messages
    await this.updateInvitationMessages(updatedEvent);
  }

  /**
   * The creator tapped candidate `choiceIndex` of picker `pickerId`. The tap answers the event's
   * open picker (`answerPicker`); a tap on an older, answered or expired picker, or on one built
   * for a text the event no longer has, returns false and changes nothing, so a place is only
   * applied from the list its button showed, for the text it was found for.
   */
  async handleLocationChoice(eventId: number, userId: number, pickerId: string, choiceIndex: number): Promise<boolean> {
    // Only indexes a picker can show; anything else must not consume the picker
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= MAX_CANDIDATES) return false;
    const answered = await this.answerPicker(eventId, userId, pickerId);
    const chosen = answered?.picker.candidates[choiceIndex];
    if (!answered || !chosen) return false;

    const user = this.deps.userRepo.findByTelegramId(userId);
    if (!user) return false;

    await this.applyResolvedLocation(answered.event, chosen);
    await this.cacheAndUpdateCity(user, answered.picker.location, chosen);

    return true;
  }

  /**
   * Answer the event's open picker `pickerId` (`LocationCandidateStore.take`). Only a user who can
   * see the event consumes it, and it counts only while the event still has the text the picker was
   * built for: an edit that does not re-verify (the /edit scene, an abstract location, a calendar
   * sync) may have changed it, and then the picker's places answer the old text. The event is read
   * again after the take, which yields, so an edit during it is seen too.
   */
  private async answerPicker(
    eventId: number,
    userId: number,
    pickerId: string,
  ): Promise<{ picker: LocationPicker; event: CalendarEvent } | null> {
    if (!this.deps.eventRepo.findById(eventId, userId)) return null;
    const picker = await this.deps.candidateStore.take(eventId, pickerId);
    if (!picker) return null;
    const event = this.deps.eventRepo.findById(eventId, userId);
    if (!event || event.location !== picker.location) return null;
    return { picker, event };
  }

  /** Reverse geocode coordinates to extract city. Used by callback handler to avoid ad-hoc service creation. */
  async reverseGeocodeForCity(lat: number, lng: number): Promise<{ city: string } | null> {
    const result = await this.deps.geocodingService.reverseGeocode(lat, lng);
    if (!result?.city) return null;
    return { city: result.city };
  }

  /**
   * Resolve the event's place from a location the user shared for it: a Telegram venue is applied as
   * picked, with its name and address; a plain pin is reverse-geocoded to an address.
   */
  async resolveFromSharedLocation(eventId: number, shared: SharedLocation, userId: number): Promise<boolean> {
    // Verify user has access to the event before doing any work
    const event = this.deps.eventRepo.findById(eventId, userId);
    if (!event) return false;

    // A venue is the place as the user picked it; a reverse geocode would replace its name with the
    // street address at its coordinates
    const { venue } = shared;
    const geo: GeocodedLocation | null = venue
      ? {
          formattedAddress: venue.address,
          latitude: shared.latitude,
          longitude: shared.longitude,
          city: null,
          country: null,
          placeId: venue.googlePlaceId,
          googleMapsUrl: buildGoogleMapsUrl(shared.latitude, shared.longitude, venue.googlePlaceId),
          venueName: venue.title,
        }
      : await this.deps.geocodingService.reverseGeocode(shared.latitude, shared.longitude);
    if (!geo) return false;

    const user = this.deps.userRepo.findByTelegramId(userId);
    if (!user) return false;

    // The shared location answers any open picker for this event; closing it before applying means a
    // keep tap on it either lands before the location (and the location wins) or finds it answered.
    await this.deps.candidateStore.del(eventId).catch((err) => {
      logger.warn({ err, eventId }, 'Failed to delete location candidates from store');
    });
    await this.applyResolvedLocation(event, geo);
    if (event.location) {
      await this.cacheAndUpdateCity(user, event.location, geo);
    }
    return true;
  }

  /**
   * The creator keeps the typed location ("none of these — keep as typed"): the event stays (or
   * becomes again) unverified with only the typed text, the offered candidates are dropped, and a
   * remembered place the picker offered is forgotten so it is not offered again. A place confirmed
   * for the text after this picker was sent stays remembered. Nothing is cached.
   *
   * Like a candidate tap, it answers the event's open picker; a tap on an older, answered or
   * expired picker, or on one built for a text the event no longer has, returns null and changes
   * nothing, so it never erases a place the creator confirmed after that picker was sent.
   */
  async keepTypedLocation(eventId: number, userId: number, pickerId: string): Promise<CalendarEvent | null> {
    const answered = await this.answerPicker(eventId, userId, pickerId);
    if (!answered) return null;
    const { picker, event } = answered;

    await this.keepOnlyTypedText(event);
    const offered = picker.candidates[0];
    if (picker.remembered && offered) {
      const rejected = {
        resolvedAddress: offered.formattedAddress,
        placeId: offered.placeId,
        latitude: offered.latitude,
        longitude: offered.longitude,
      };
      await this.deps.addressCache.forgetMapping(userId, picker.location, rejected).catch((err) => {
        logger.warn({ err, eventId, userId }, 'Failed to forget rejected address mapping');
      });
    }
    return event;
  }

  /**
   * Learn from a place the creator explicitly confirmed (candidate tap or a pin shared for the
   * event): remember the typed text → place mapping, and fill an empty home city, but only with a
   * place in the creator's region (their timezone zone or home country), so a venue abroad never
   * becomes the home city. An existing city is never overwritten.
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
   * Search bias toward the creator's home area. The home city anchors searches only when it lies in
   * the creator's region: a city learned from a wrong guess must not pull every later search toward
   * it. Otherwise the home country; none when neither is known.
   */
  private async homeAreaBias(user: User): Promise<GeocodingBias | undefined> {
    const countryCode = homeCountryCode(user);
    if (user.city) {
      const city = await this.deps.geocodingService.locateArea({ city: user.city, countryCode });
      if (city && isInUserRegion(user, city)) {
        return { countryCode: city.countryCode, bounds: city.bounds };
      }
      logger.warn(
        { userId: user.telegram_id, countryCode, cityCountryCode: city?.countryCode ?? null },
        'Home city is outside the user timezone and home country; biasing geocoding by country only',
      );
    }
    if (!countryCode) return undefined;

    const country = await this.deps.geocodingService.locateArea({ city: null, countryCode });
    return { countryCode, bounds: country?.bounds ?? null };
  }

  /**
   * The creator kept the typed text: drop any resolved place (re-pushing the Google copies if they
   * showed it) and re-render every delivered invitation card. The edit or question that dropped a
   * place already re-rendered them, but that render may have failed; the answer is rare and
   * idempotent, so the cards are always refreshed once more rather than tracking what they last
   * showed.
   */
  private async keepOnlyTypedText(event: CalendarEvent): Promise<void> {
    const typedOnly = await this.dropResolvedPlace(event);
    logger.info({ eventId: event.id }, 'Event location kept as typed');

    await this.updateInvitationMessages(typedOnly);
  }

  /**
   * Drop the event's resolved place, if it has one, so only the typed text remains, unverified, and
   * re-push the Google copies that showed it. Returns the event as it now is.
   */
  private async dropResolvedPlace(event: CalendarEvent): Promise<CalendarEvent> {
    const typedOnly: CalendarEvent = { ...event, ...UNRESOLVED_PLACE };
    if (event.location_verified !== 0 || event.resolved_address !== null) {
      this.deps.eventRepo.clearLocationFields(event.id);
      await this.pushGoogleCopiesIfShownPlaceChanged(event, typedOnly);
    }
    return typedOnly;
  }

  /**
   * Google Calendar copies were pushed when the event was saved, before the creator answered, and
   * show the location as `formatLocationPlain` renders it (event-mapper). Re-push them when that
   * text changed; an answer that leaves it as it was queues nothing.
   */
  private async pushGoogleCopiesIfShownPlaceChanged(before: CalendarEvent, after: CalendarEvent): Promise<void> {
    const push = this.deps.pushGoogleCopies;
    if (!push || formatLocationPlain(before) === formatLocationPlain(after)) return;
    await push(after).catch((err) => {
      logger.error({ err, eventId: after.id }, 'Failed to schedule Google Calendar pushes for the event place');
    });
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

  private async askUserToChoose(event: CalendarEvent, user: User, found: Omit<LocationPicker, 'id'>): Promise<void> {
    const msgs = t(user.language).aiTools.location;

    const limited = found.candidates.slice(0, MAX_CANDIDATES);
    const options = limited.map((c, i) => `${i + 1}. ${placeLinkHtml(c)}`);
    const text = `${msgs.clarifyAddress(escapeHtml(event.title))}\n\n${options.join('\n')}`;

    // The open picker replaces any earlier one for this event; its id in the buttons tells a tap on
    // this message from a tap on an older one. Eight hex digits are plenty: an id is only ever
    // compared with the one picker of the same event, and callback_data is capped at 64 bytes.
    const pickerId = crypto.randomUUID().slice(0, 8);
    const callbackPrefix = `${CB.LOCATION_CANDIDATE}:${event.id}:${pickerId}`;
    await this.deps.candidateStore.set(event.id, { ...found, id: pickerId, candidates: limited }).catch((err) => {
      logger.error({ err, eventId: event.id }, 'Failed to store location candidates');
    });

    // One row per place, labelled with its name; the numbers match the linked list above
    const rows = limited.map((c, i) => [
      { text: `${i + 1}. ${c.venueName ?? c.formattedAddress}`, callback_data: `${callbackPrefix}:${i}` },
    ]);

    await this.notify(user, text, [...rows, [{ text: msgs.noneOfThese, callback_data: `${callbackPrefix}:keep` }]]);
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
    await refreshInvitationCards(event, { ...this.deps, editMessage });
  }
}
