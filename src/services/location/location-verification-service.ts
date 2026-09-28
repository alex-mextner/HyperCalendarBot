// src/services/location/location-verification-service.ts

import type { InlineKeyboard, TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { AgendaRepository } from '../../database/repositories/agenda.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, Invitation, InvitationStatus, User } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { formatInvitation } from '../event/formatters.ts';
import { formatAnsweredInvitationCard } from '../sharing/answered-invitation-card.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from '../sharing/invitation-rsvp-keyboard.ts';
import { guessCountryFromTimezone, resolveTimezone } from '../timezone/timezone-service.ts';
import type { WeatherService } from '../weather/weather-service.ts';
import type { AddressCache } from './address-cache.ts';
import type { GeocodedLocation, GeocodingBias, GeocodingService } from './geocoding-service.ts';
import type { LocationCandidateStore, LocationPicker } from './location-candidate-store.ts';

type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;
type InvitationEditOptions = { parse_mode: ParseMode; reply_markup?: InlineKeyboard };
type RenderedInvitationCard = { text: string; options: InvitationEditOptions };
/** Statuses whose card is still on screen as the recipient last saw it */
type LiveInvitationStatus = Exclude<InvitationStatus, 'cancelled' | 'expired'>;

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
  /**
   * Live secretary-access lookup, used only to let a current active write-secretary act on the
   * owner's personal event (#421). Absent means no delegated access is ever granted — the service
   * falls back to requiring the acting user to own or otherwise see the event, exactly as before.
   */
  secretaryRepo?: Pick<SecretaryRepository, 'findByOwnerAndSecretary'>;
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
   * for an earlier text is dropped), delivered invitations are not edited, and neither the
   * address cache nor `users.city` is touched. The previous picker of the event is closed.
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
    const canSeeEvent = this.getEventVisibleToActor(event.id, user.telegram_id) !== null;
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
    // earlier text must not stay on it, whoever changed the text. Invitation cards are re-rendered
    // only on the answer.
    if (event.location_verified !== 0 || event.resolved_address !== null) {
      this.deps.eventRepo.clearLocationFields(event.id);
    }

    // Only a user who can see the event is asked: the owner, or (for a personal event) a current
    // active write secretary of the owner (#421).
    if (!canSeeEvent) {
      logger.info({ eventId: event.id, userId: user.telegram_id }, 'User cannot see the event; not asking');
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    logger.info({ eventId: event.id, location, userId: user.telegram_id }, 'Starting location verification');

    // The search and any remembered mapping are scoped to the calendar owner only when `user` is a
    // secretary acting on the owner's personal event: a delegate's own history or home area must
    // not leak into the owner's calendar. A group event's `user_id` is just its creator, so another
    // member editing it keeps using their own profile, exactly as before #421. The picker itself
    // always goes to whoever is asking (`user`, below).
    const scopeUser = this.isDelegatedPersonalAccess(event, user.telegram_id)
      ? (this.deps.userRepo.findByTelegramId(event.user_id) ?? user)
      : user;
    const { candidates, remembered } = await this.findCandidates(event, scopeUser, location);

    // The event changed while the search ran: its text (a newer text starts its own verification,
    // which may already have stored its picker), or it was deleted, or a pin confirmed a place
    // (this verification cleared any earlier one), or — for a delegate — write access was revoked
    // mid-search. Asking now would replace the newer question, let a keep tap erase the pin, or ask
    // someone no longer allowed to answer. No await may come between this check and the picker's
    // `set` in `askUserToChoose`.
    const current = this.getEventVisibleToActor(event.id, user.telegram_id);
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
   * The event `eventId` as `actorId` may act on it right now: the actor's own view
   * (`EventRepository.findById`, which also covers group visibility — unchanged, never widened),
   * or — for a personal event owned by someone else — the owner's view, granted only while
   * `actorId` currently holds active write secretary access to that owner. Checked fresh on every
   * call: a grant revoked between two calls stops granting on the next one (#421). Never grants a
   * group event through a secretary relationship — that stays governed by group membership alone.
   */
  getEventVisibleToActor(eventId: number, actorId: number): CalendarEvent | null {
    const own = this.deps.eventRepo.findById(eventId, actorId);
    if (own) return own;
    if (!this.deps.secretaryRepo) return null;
    const unfiltered = this.deps.eventRepo.findByIdUnfiltered(eventId);
    if (!unfiltered || unfiltered.owner_type === 'group' || unfiltered.user_id === actorId) return null;
    const record = this.deps.secretaryRepo.findByOwnerAndSecretary(unfiltered.user_id, actorId);
    if (!record || record.status !== 'active' || record.permission !== 'write') return null;
    return this.deps.eventRepo.findById(eventId, unfiltered.user_id);
  }

  /**
   * True only when `actorId` is a secretary acting on behalf of the owner of a personal event —
   * never for a group event, where a differing `event.user_id` just means someone other than its
   * creator is editing it, and never when `actorId` already is the owner. Gates every place the
   * owner's profile (search bias, address cache, city auto-fill) replaces the acting user's own —
   * a group co-editor keeps using their own profile, exactly as before #421.
   */
  private isDelegatedPersonalAccess(event: Pick<CalendarEvent, 'owner_type' | 'user_id'>, actorId: number): boolean {
    return event.owner_type !== 'group' && event.user_id !== actorId;
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

  /** Apply the place the creator confirmed (candidate tap or pin) and update delivered invitations. */
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

    // Cache/history and the city fill are scoped to the calendar owner only for a secretary acting
    // on the owner's personal event; a group co-editor keeps using their own profile, and a
    // delegated tap never touches the owner's city either (#421).
    const delegated = this.isDelegatedPersonalAccess(answered.event, userId);
    const scopeUser = delegated
      ? this.deps.userRepo.findByTelegramId(answered.event.user_id)
      : this.deps.userRepo.findByTelegramId(userId);
    if (!scopeUser) return false;

    await this.applyResolvedLocation(answered.event, chosen);
    await this.cacheAndUpdateCity(scopeUser, answered.picker.location, chosen, !delegated);

    return true;
  }

  /**
   * Answer the event's open picker `pickerId` (`LocationCandidateStore.take`). Only a user who can
   * currently act on the event (its owner, or — for a personal event — a live active write
   * secretary of the owner) consumes it, and it counts only while the event still has the text the
   * picker was built for: an edit that does not re-verify (the /edit scene, an abstract location, a
   * calendar sync) may have changed it, and then the picker's places answer the old text. The
   * access check runs again after the take, which yields, so a revoke or an edit during it is seen
   * too, and an unauthorized call never reaches `take` in the first place — it can't consume the
   * picker for the rightful user.
   */
  private async answerPicker(
    eventId: number,
    userId: number,
    pickerId: string,
  ): Promise<{ picker: LocationPicker; event: CalendarEvent } | null> {
    if (!this.getEventVisibleToActor(eventId, userId)) return null;
    const picker = await this.deps.candidateStore.take(eventId, pickerId);
    if (!picker) return null;
    const event = this.getEventVisibleToActor(eventId, userId);
    if (!event || event.location !== picker.location) return null;
    return { picker, event };
  }

  /** Reverse geocode coordinates to extract city. Used by callback handler to avoid ad-hoc service creation. */
  async reverseGeocodeForCity(lat: number, lng: number): Promise<{ city: string } | null> {
    const result = await this.deps.geocodingService.reverseGeocode(lat, lng);
    if (!result?.city) return null;
    return { city: result.city };
  }

  /** Resolve location from coordinates (when user sends 📍 for an event) */
  async resolveFromCoordinates(eventId: number, lat: number, lng: number, userId: number): Promise<boolean> {
    // Verify the user can currently act on the event before doing any work — same contract as the
    // candidate picker (#421): the owner, or a live active write secretary of the owner.
    const event = this.getEventVisibleToActor(eventId, userId);
    if (!event) return false;

    const geo = await this.deps.geocodingService.reverseGeocode(lat, lng);
    if (!geo) return false;

    // Cache/history and the city fill are scoped to the calendar owner only for a secretary acting
    // on the owner's personal event; a group co-editor keeps using their own profile (#421).
    const delegated = this.isDelegatedPersonalAccess(event, userId);
    const scopeUser = delegated
      ? this.deps.userRepo.findByTelegramId(event.user_id)
      : this.deps.userRepo.findByTelegramId(userId);
    if (!scopeUser) return false;

    // The pin answers any open picker for this event; closing it before applying means a keep tap
    // on it either lands before the pin (and the pin wins) or finds it answered.
    await this.deps.candidateStore.del(eventId).catch((err) => {
      logger.warn({ err, eventId }, 'Failed to delete location candidates from store');
    });
    await this.applyResolvedLocation(event, geo);
    if (event.location) {
      await this.cacheAndUpdateCity(scopeUser, event.location, geo, !delegated);
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
      // The rejected mapping is forgotten in the owner's cache only for a delegated personal
      // confirmation — the same scope the offer came from; a group co-editor's own cache is used
      // otherwise, exactly as before #421.
      const forgetScopeId = this.isDelegatedPersonalAccess(event, userId) ? event.user_id : userId;
      await this.deps.addressCache.forgetMapping(forgetScopeId, picker.location, rejected).catch((err) => {
        logger.warn({ err, eventId, userId }, 'Failed to forget rejected address mapping');
      });
    }
    return event;
  }

  /**
   * Learn from a place the creator explicitly confirmed (candidate tap or a pin shared for the
   * event): remember the typed text → place mapping, and — only when `allowCityUpdate` — fill an
   * empty home city, but only with a place in the creator's region (their timezone zone or home
   * country), so a venue abroad never becomes the home city. An existing city is never overwritten.
   * `allowCityUpdate` is false for a delegated confirmation (a secretary answering the owner's
   * picker): the owner's cache/history still records the place, but no profile city is auto-filled
   * from a delegate's tap, and a delegate's own city is never touched — `user` here is always the
   * calendar owner, never the delegate (#421).
   */
  private async cacheAndUpdateCity(
    user: User,
    inputLocation: string,
    geo: GeocodedLocation,
    allowCityUpdate: boolean,
  ): Promise<void> {
    // Cache the mapping
    await this.deps.addressCache.recordMapping(user.telegram_id, inputLocation, {
      resolvedAddress: geo.formattedAddress,
      googleMapsUrl: geo.googleMapsUrl,
      latitude: geo.latitude,
      longitude: geo.longitude,
      placeId: geo.placeId,
      venueName: geo.venueName,
    });

    if (allowCityUpdate && !user.city && geo.city && isInUserRegion(user, geo)) {
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
   * The creator kept the typed text: drop any resolved place and re-render every delivered
   * invitation card. A card may still show a place dropped before this answer (when the text
   * changed or an earlier question was asked), and the answer is rare and idempotent, so the cards
   * are always refreshed rather than tracking what they last showed.
   */
  private async keepOnlyTypedText(event: CalendarEvent): Promise<void> {
    if (event.location_verified !== 0 || event.resolved_address !== null) {
      this.deps.eventRepo.clearLocationFields(event.id);
    }
    logger.info({ eventId: event.id }, 'Event location kept as typed');

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
