// test/services/location/invitation-cards-location-edit.test.ts
// #428: a delivered invitation card must not keep a place the event dropped. The card used to be
// re-rendered only when the creator answered the location question, so an edit to a text that finds
// no place, or to an abstract location, left the old venue and its map link on the card for good.
// Real SQLite repositories, the real AI update_event handler, the real verification service with a
// scripted geocoder, and the real callback handler for the keep tap.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { InlineKeyboard } from 'gramio';
import { t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { handleUpdateEvent } from '../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { AddressCache } from '../../../src/services/location/address-cache.ts';
import type { GeocodedLocation } from '../../../src/services/location/geocoding-service.ts';
import { InMemoryLocationCandidateStore } from '../../../src/services/location/location-candidate-store.ts';
import { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';

const OWNER_ID = 1001;
const INVITEE_ID = 2002;

/** The place the creator confirmed for the original text. */
const OLD_PLACE = {
  resolved_address: 'Example Boulevard 7, Sampletown',
  latitude: 52.11,
  longitude: 4.28,
  google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_OLD_PLACE',
  location_verified: 1,
  venue_name: 'Seaside Hotel Example',
};

const HARBOUR_CAFE: GeocodedLocation = {
  formattedAddress: 'Harbour Street 3, Sampletown',
  latitude: 52.2,
  longitude: 4.3,
  city: 'Sampletown',
  country: 'Exampleland',
  placeId: 'SYNTHETIC_HARBOUR',
  googleMapsUrl: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_HARBOUR',
  venueName: 'Harbour Cafe',
};

interface CardEdit {
  text: string;
  keyboard: InlineKeyboard | undefined;
}

let db: Database;
afterEach(() => db.close());

/** Holds the next `del` (the question closing the previous picker) until the test releases it. */
class GatedCandidateStore extends InMemoryLocationCandidateStore {
  gate: Promise<void> | null = null;

  override async del(eventId: number): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    await super.del(eventId);
  }
}

/** A resolved event with a pending invitation card delivered to the invitee. */
function setup(
  search: { [text: string]: GeocodedLocation[] } = {},
  candidateStore: InMemoryLocationCandidateStore = new InMemoryLocationCandidateStore(),
) {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  const owner = users.create({ telegram_id: OWNER_ID, language: 'en', timezone: 'UTC' });
  users.create({ telegram_id: INVITEE_ID, language: 'en', timezone: 'UTC' });
  const events = new EventRepository(db);
  const event = events.create({
    user_id: OWNER_ID,
    title: 'Dinner',
    start_at: '2026-10-05T17:00:00Z',
    end_at: '2026-10-05T18:00:00Z',
    timezone: 'UTC',
    location: 'seaside hotel',
  });
  events.updateLocationFields(event.id, OLD_PLACE);
  const invitations = new InvitationRepository(db);
  const invitation = invitations.create({
    event_id: event.id,
    inviter_id: OWNER_ID,
    invitee_id: INVITEE_ID,
    message_id: 77,
    chat_id: INVITEE_ID,
  });

  const cards: CardEdit[] = [];
  const toCreator: { text: string; callbacks: string[] }[] = [];
  let creatorWasTold = Promise.withResolvers<void>();
  const redis = new Map<string, string>();
  const verification = new LocationVerificationService({
    geocodingService: {
      findPlace: async (text) => search[text] ?? [],
      geocodeAddress: async () => [],
      reverseGeocode: async () => null,
      locateArea: async () => null,
    },
    addressCache: new AddressCache({
      get: async (key) => redis.get(key) ?? null,
      set: async (key, value) => redis.set(key, value),
    }),
    eventRepo: events,
    userRepo: users,
    invitationRepo: invitations,
    agendaRepository: new AgendaRepository(db),
    candidateStore,
    sendMessage: async (_userId, text, options) => {
      const markup = options?.reply_markup;
      const rows = markup && 'inline_keyboard' in markup ? markup.inline_keyboard : [];
      toCreator.push({ text, callbacks: rows.flat().flatMap((b) => (b.callback_data ? [b.callback_data] : [])) });
      creatorWasTold.resolve();
    },
    editMessage: async (_chatId, _messageId, text, options) => {
      cards.push({ text, keyboard: options.reply_markup });
    },
  });
  // The handler reads only these fields; the one cast in this file
  const ctx = {
    user: owner,
    eventService: new EventService({ eventRepo: events }),
    locationVerification: verification,
  };
  const agentCtx = ctx as unknown as AgentContext;

  /** update_event from the assistant; resolves once the background location question was sent. */
  async function editLocation(fields: { location: string; location_abstract?: boolean; start_at?: string }) {
    creatorWasTold = Promise.withResolvers<void>();
    const result = await handleUpdateEvent(agentCtx, { event_id: event.id, ...fields });
    expect(result.success).toBe(true);
    if (!fields.location_abstract) await creatorWasTold.promise;
  }

  /** The id of the open picker the creator was last sent. */
  function latestPickerId(): string {
    const data = toCreator.at(-1)?.callbacks[0];
    if (!data) throw new Error('no picker sent');
    return data.split(':')[2] ?? '';
  }

  return { event, events, invitation, verification, agentCtx, cards, toCreator, editLocation, latestPickerId };
}

function expectNoOldPlace(card: CardEdit | undefined): void {
  expect(card?.text).not.toContain(OLD_PLACE.venue_name);
  expect(card?.text).not.toContain(OLD_PLACE.resolved_address);
  expect(card?.text).not.toContain('SYNTHETIC_OLD_PLACE');
}

describe('a location edit re-renders delivered invitation cards that showed the dropped place', () => {
  test('a new text that finds no place: the card shows the new text with its RSVP buttons, no old place', async () => {
    const s = setup();

    await s.editLocation({ location: 'at Ira’s place' });

    expect(s.toCreator.at(-1)?.text).toBe(t('en').aiTools.location.locationNotFound('Dinner'));
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]?.text).toContain('at Ira’s place');
    expectNoOldPlace(s.cards[0]);
    expect(s.cards[0]?.keyboard).toEqual(invitationRsvpKeyboard(s.invitation.id, 'en'));
  });

  test('an abstract location: the card shows the typed text, no old place', async () => {
    const s = setup();

    await s.editLocation({ location: 'home', location_abstract: true });

    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]?.text).toContain('home');
    expectNoOldPlace(s.cards[0]);
    expect(s.cards[0]?.keyboard).toEqual(invitationRsvpKeyboard(s.invitation.id, 'en'));
  });

  test('the same text asked again drops the confirmed place: the card loses it even when nothing is found', async () => {
    const s = setup();

    // The assistant re-sends the unchanged location with a new time; the question is asked again
    await s.editLocation({ location: 'seaside hotel', start_at: '2026-10-05T18:00:00Z' });

    expect(s.events.findById(s.event.id, OWNER_ID)?.location_verified).toBe(0);
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]?.text).toContain('seaside hotel');
    expectNoOldPlace(s.cards[0]);
  });

  test('two edits before the creator answers, then keep as typed: no card shows the original place', async () => {
    const s = setup({ 'harbour cafe': [HARBOUR_CAFE], 'harbor cafe': [HARBOUR_CAFE] });

    await s.editLocation({ location: 'harbour cafe' });
    await s.editLocation({ location: 'harbor cafe' });
    expect(await s.verification.keepTypedLocation(s.event.id, OWNER_ID, s.latestPickerId())).not.toBeNull();

    expect(s.cards.length).toBeGreaterThan(0);
    for (const card of s.cards) expectNoOldPlace(card);
    expect(s.cards.at(-1)?.text).toContain('harbor cafe');
    expect(s.cards.at(-1)?.keyboard).toEqual(invitationRsvpKeyboard(s.invitation.id, 'en'));
  });

  test('an edit that leaves the location as it was does not touch the cards', async () => {
    const s = setup();

    const result = await handleUpdateEvent(s.agentCtx, { event_id: s.event.id, description: 'bring flowers' });

    expect(result.success).toBe(true);
    expect(s.cards).toEqual([]);
  });

  test('an edit landing while the question for the re-sent text starts: the card keeps the newer text', async () => {
    const store = new GatedCandidateStore();
    const s = setup({}, store);
    const questions = spyOn(s.verification, 'verifyEventLocation');
    const released = Promise.withResolvers<void>();
    store.gate = released.promise;

    // The assistant re-sends the confirmed text with a new time: its question waits on closing the
    // previous picker, still holding the event as it was (place confirmed)
    const first = await handleUpdateEvent(s.agentCtx, {
      event_id: s.event.id,
      location: 'seaside hotel',
      start_at: '2026-10-05T18:00:00Z',
    });
    expect(first.success).toBe(true);
    // A second edit changes the text meanwhile and re-renders the card itself
    await s.editLocation({ location: 'at Ira’s place' });
    released.resolve();
    await Promise.all(questions.mock.results.map((r) => r.value));

    // Only the second edit's render: the question's older snapshot must not repaint the card
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]?.text).toContain('at Ira’s place');
    expectNoOldPlace(s.cards[0]);
  });

  test('a time edit landing while the question for the re-sent text starts: the card shows the newer time', async () => {
    const store = new GatedCandidateStore();
    const s = setup({}, store);
    const questions = spyOn(s.verification, 'verifyEventLocation');
    const released = Promise.withResolvers<void>();
    store.gate = released.promise;

    const first = await handleUpdateEvent(s.agentCtx, {
      event_id: s.event.id,
      location: 'seaside hotel',
      start_at: '2026-10-05T18:00:00Z',
    });
    expect(first.success).toBe(true);
    // A time-only edit meanwhile leaves the location line alone, so it does not re-render the card
    const moved = await handleUpdateEvent(s.agentCtx, {
      event_id: s.event.id,
      start_at: '2026-10-05T19:30:00Z',
      end_at: '2026-10-05T20:30:00Z',
    });
    expect(moved.success).toBe(true);
    released.resolve();
    await Promise.all(questions.mock.results.map((r) => r.value));

    // The question drops the place from the card, with the event's time as it is now
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]?.text).toContain('seaside hotel');
    expect(s.cards[0]?.text).toContain('19:30');
    expect(s.cards[0]?.text).not.toContain('18:00');
    expectNoOldPlace(s.cards[0]);
  });
});
