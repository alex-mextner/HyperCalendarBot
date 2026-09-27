// test/bot/scenes/edit-value.scene.test.ts
//
// The Location edit button (#395): a new location must drop the old resolved
// place and go through the same verification and clarification flow as the AI
// update_event tool.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { createUserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createEditValueScene } from '../../../src/bot/scenes/edit-value.scene.ts';
import type { DatabaseService } from '../../../src/database/index.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent, User } from '../../../src/database/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import type { LocationVerificationService } from '../../../src/services/location/location-verification-service.ts';

const USER_ID = 502;
const CHAT_ID = 502;
const CARD_MESSAGE_ID = 31;

const OLD_PLACE = {
  resolved_address: 'Example Boulevard 7, Sampletown',
  latitude: 52.11,
  longitude: 4.28,
  google_maps_url: 'https://www.google.com/maps/place/?q=place_id:SYNTHETIC_OLD_PLACE',
  location_verified: 1,
  venue_name: 'Seaside Hotel Example',
};

interface EditCtx {
  lang: 'en' | 'ru';
  dbUser: User;
  text: string;
  id: number;
  scene: {
    params: { eventId: number; field: string; chatId: number; messageId: number };
    step: { id: number };
    exit: Mock<() => Promise<void>>;
  };
  send: Mock<(text: string) => Promise<void>>;
  bot: { api: { editMessageText: Mock<(params: { text: string }) => Promise<void>> } };
  is: (type: string) => boolean;
}

type StepFn = (ctx: EditCtx, next: () => Promise<void>) => Promise<void>;

interface SceneInternals {
  '~': { composer: { '~': { middlewares: { fn: StepFn }[] } } };
}

/** The user resolver only reads `users`; boundary cast once here. */
function userOnlyDb(users: UserRepository): DatabaseService {
  return { users } as unknown as DatabaseService;
}

/** The scene's only step: middleware 0 is the user-resolver derive from `.extend()`. */
function getStepFn(scene: unknown): StepFn {
  const step = (scene as SceneInternals)['~'].composer['~'].middlewares[1];
  if (!step) throw new Error('edit_value step not registered');
  return step.fn;
}

describe('edit_value scene: Location button', () => {
  let db: Database;
  let events: EventRepository;
  let user: User;
  let verifyEventLocation: Mock<LocationVerificationService['verifyEventLocation']>;
  let step: StepFn;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    const users = new UserRepository(db);
    user = users.create({ telegram_id: USER_ID, timezone: 'UTC' });
    events = new EventRepository(db);
    verifyEventLocation = mock(() =>
      Promise.resolve({ resolved: false, geocoded: null, cityExtracted: null, candidates: [] }),
    );
    const composer = createUserResolverComposer(userOnlyDb(users));
    step = getStepFn(
      createEditValueScene(new EventService({ eventRepo: events }), composer, undefined, { verifyEventLocation }),
    );
  });

  function resolvedEvent(): CalendarEvent {
    const event = events.create({
      user_id: USER_ID,
      title: 'Dinner',
      start_at: '2026-10-05T17:00:00Z',
      end_at: '2026-10-05T18:00:00Z',
      timezone: 'UTC',
      location: 'seaside hotel',
    });
    events.updateLocationFields(event.id, OLD_PLACE);
    return event;
  }

  function makeCtx(eventId: number, field: string, text: string): EditCtx {
    return {
      lang: 'ru',
      dbUser: user,
      text,
      id: 40,
      scene: {
        params: { eventId, field, chatId: CHAT_ID, messageId: CARD_MESSAGE_ID },
        step: { id: 0 },
        exit: mock(() => Promise.resolve()),
      },
      send: mock(() => Promise.resolve()),
      bot: { api: { editMessageText: mock(() => Promise.resolve()) } },
      is: (type) => type === 'message',
    };
  }

  test('new location drops the old place from the card and is verified', async () => {
    const event = resolvedEvent();
    const ctx = makeCtx(event.id, 'location', 'дома');
    await step(ctx, () => Promise.resolve());

    const row = events.findById(event.id, USER_ID);
    expect(row).toMatchObject({
      location: 'дома',
      resolved_address: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });

    const [card] = ctx.bot.api.editMessageText.mock.calls[0] ?? [];
    expect(card?.text).toContain('дома');
    expect(card?.text).not.toContain(OLD_PLACE.venue_name);
    expect(card?.text).not.toContain('SYNTHETIC_OLD_PLACE');

    expect(verifyEventLocation).toHaveBeenCalledTimes(1);
    const [verifiedEvent, verifiedUser] = verifyEventLocation.mock.calls[0] ?? [];
    expect(verifiedEvent?.id).toBe(event.id);
    expect(verifiedEvent?.location).toBe('дома');
    expect(verifiedUser?.telegram_id).toBe(USER_ID);
  });

  test('"clear" removes the location with its resolved place and verifies nothing', async () => {
    const event = resolvedEvent();
    await step(makeCtx(event.id, 'location', 'clear'), () => Promise.resolve());

    expect(events.findById(event.id, USER_ID)).toMatchObject({
      location: null,
      resolved_address: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
    });
    expect(verifyEventLocation).not.toHaveBeenCalled();
  });

  test('editing another field keeps the resolved place and verifies nothing', async () => {
    const event = resolvedEvent();
    await step(makeCtx(event.id, 'title', 'Late dinner'), () => Promise.resolve());

    expect(events.findById(event.id, USER_ID)).toMatchObject({ title: 'Late dinner', ...OLD_PLACE });
    expect(verifyEventLocation).not.toHaveBeenCalled();
  });
});
