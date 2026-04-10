// src/services/location/location-verification-service.ts

import type { TelegramInlineKeyboardMarkup, TelegramReplyKeyboardMarkup } from 'gramio';
import { t } from '../../config/constants.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import { botLogger } from '../../utils/logger.ts';
import { formatInvitation } from '../event/formatters.ts';
import type { AddressCache } from './address-cache.ts';
import type { GeocodedLocation, GeocodingService } from './geocoding-service.ts';
import type { LocationCandidateStore } from './location-candidate-store.ts';

type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';
type ReplyMarkup = TelegramInlineKeyboardMarkup | TelegramReplyKeyboardMarkup;

const logger = botLogger.child({ module: 'location-verification' });

export interface LocationVerificationDeps {
  geocodingService: GeocodingService;
  addressCache: AddressCache;
  eventRepo: EventRepository;
  userRepo: UserRepository;
  invitationRepo: InvitationRepository;
  /** Temporary store for location candidates (Redis-backed with TTL) */
  candidateStore: LocationCandidateStore;
  /** Callback to send a message to a user (for confirmation/clarification) */
  sendMessage: (
    userId: number,
    text: string,
    options?: { parse_mode?: ParseMode; reply_markup?: ReplyMarkup },
  ) => Promise<void>;
  /** Callback to edit an existing invitation message */
  editMessage?: (chatId: number, messageId: number, text: string, parseMode?: ParseMode) => Promise<void>;
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
   * 1. Check address cache for known mapping
   * 2. If not cached, geocode via Google Maps API (using user city as bias)
   * 3. If single confident result → auto-resolve
   * 4. If multiple candidates → ask user to choose
   * 5. Update event with resolved location
   * 6. Update user city if not set
   * 7. Update sent invitations with new location
   * 8. Cache the mapping
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
      logger.info({ eventId: event.id, cached: cached.resolvedAddress }, 'Found cached address mapping');
      await this.applyResolvedLocation(event, {
        formattedAddress: cached.resolvedAddress,
        latitude: cached.latitude,
        longitude: cached.longitude,
        city: null,
        country: null,
        placeId: cached.placeId,
        googleMapsUrl: cached.googleMapsUrl,
      });
      return {
        resolved: true,
        geocoded: {
          formattedAddress: cached.resolvedAddress,
          latitude: cached.latitude,
          longitude: cached.longitude,
          city: null,
          country: null,
          placeId: cached.placeId,
          googleMapsUrl: cached.googleMapsUrl,
        },
        cityExtracted: null,
        candidates: [],
      };
    }

    // 2. Geocode via Google Maps
    const biasCity = user.city ?? undefined;

    // Try place search first (handles venue names better), fallback to geocoding
    let results = await this.deps.geocodingService.findPlace(location, biasCity);
    if (results.length === 0) {
      results = await this.deps.geocodingService.geocodeAddress(location, biasCity);
    }

    if (results.length === 0) {
      logger.info({ eventId: event.id, location }, 'No geocoding results found');
      return { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };
    }

    // 3. Single confident result → auto-resolve
    if (results.length === 1) {
      const geo = results[0]!;
      await this.applyResolvedLocation(event, geo);
      await this.cacheAndUpdateCity(user, location, geo);
      return { resolved: true, geocoded: geo, cityExtracted: geo.city, candidates: [] };
    }

    // 4. Multiple candidates → ask user to choose
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
    // Update event in DB
    this.deps.eventRepo.updateLocationFields(event.id, {
      resolved_address: geo.formattedAddress,
      latitude: geo.latitude,
      longitude: geo.longitude,
      google_maps_url: geo.googleMapsUrl,
      location_verified: 1,
    });

    logger.info({ eventId: event.id, resolvedAddress: geo.formattedAddress }, 'Event location resolved');

    // Build the updated event in-memory (avoids re-fetching from DB just to get the new fields)
    const updatedEvent: CalendarEvent = {
      ...event,
      resolved_address: geo.formattedAddress,
      latitude: geo.latitude,
      longitude: geo.longitude,
      google_maps_url: geo.googleMapsUrl,
      location_verified: 1,
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

  private async cacheAndUpdateCity(user: User, inputLocation: string, geo: GeocodedLocation): Promise<void> {
    // Cache the mapping
    await this.deps.addressCache.recordMapping(user.telegram_id, inputLocation, {
      resolvedAddress: geo.formattedAddress,
      googleMapsUrl: geo.googleMapsUrl,
      latitude: geo.latitude,
      longitude: geo.longitude,
      placeId: geo.placeId,
    });

    // Update user city if not set and we extracted one
    if (!user.city && geo.city) {
      this.deps.userRepo.update(user.telegram_id, { city: geo.city });
      logger.info({ userId: user.telegram_id, city: geo.city }, 'User city set from location');
    }
  }

  private async askUserToChoose(event: CalendarEvent, user: User, candidates: GeocodedLocation[]): Promise<void> {
    const header = t(user.language).aiTools.location.clarifyAddress(event.title);

    const limited = candidates.slice(0, 5);
    const options = limited.map((c, i) => `${i + 1}. ${c.formattedAddress}`);
    const text = `${header}\n\n${options.join('\n')}`;

    // Persist candidates in Redis so the callback handler can retrieve them
    await this.deps.candidateStore.set(event.id, limited).catch((err) => {
      logger.error({ err, eventId: event.id }, 'Failed to store location candidates');
    });

    const buttons = limited.map((_c, i) => ({
      text: `${i + 1}`,
      callback_data: `loc_cand:${event.id}:${i}`,
    }));

    const inlineKeyboard = [buttons];

    try {
      await this.deps.sendMessage(user.telegram_id, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: inlineKeyboard },
      });
    } catch (err) {
      logger.error({ err, userId: user.telegram_id }, 'Failed to send location choice');
    }
  }

  /** Update all invitation messages for an event after location is resolved */
  private async updateInvitationMessages(event: CalendarEvent): Promise<void> {
    if (!this.deps.editMessage) return;

    // Find all invitations (pending + accepted) that have been delivered
    const pending = this.deps.invitationRepo.getPendingForEvent(event.id);
    const accepted = this.deps.invitationRepo.getAcceptedForEvent(event.id);
    const allInvitations = [...pending, ...accepted];

    for (const inv of allInvitations) {
      if (!inv.message_id || !inv.chat_id) continue;

      try {
        const inviter = this.deps.userRepo.findByTelegramId(inv.inviter_id);
        const invitee = this.deps.userRepo.findByTelegramId(inv.invitee_id);

        const text = formatInvitation(
          event,
          event.timezone,
          invitee?.language ?? 'en',
          inviter?.first_name ?? inviter?.username ?? 'User',
          inv.inviter_id,
          inviter?.username,
          invitee?.timezone,
          invitee?.onboarding_completed === 1,
        );

        await this.deps.editMessage(inv.chat_id, inv.message_id, text, 'HTML');
      } catch (err) {
        logger.warn(
          { err, invitationId: inv.id, eventId: event.id },
          'Failed to update invitation message after location resolution',
        );
      }
    }
  }
}
