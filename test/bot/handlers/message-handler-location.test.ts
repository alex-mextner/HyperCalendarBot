import { describe, expect, mock, test } from 'bun:test';
import { Location } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';
import type { BotCallbackContext } from '../../../src/bot/types.ts';
import type {
  LocationVerificationResult,
  LocationVerificationService,
} from '../../../src/services/location/location-verification-service.ts';
import type { PendingGeoStore, SharedLocation } from '../../../src/services/location/pending-geo-store.ts';
import { agendaEvent } from '../../fixtures/agenda269.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage, telegramChat } from '../telegram-fixtures.ts';
import { makeHandlerDeps, makeMessageCtx } from './message-handler-fixtures.ts';

const MOSCOW = { latitude: 55.7558, longitude: 37.6173 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
const UNRESOLVED: LocationVerificationResult = { resolved: false, geocoded: null, cityExtracted: null, candidates: [] };

describe('createMessageHandler', () => {
  describe('location message → timezone confirmation', () => {
    test('sends confirmation prompt with buttons when timezone differs', async () => {
      const handler = createMessageHandler(makeHandlerDeps());
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'ru', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Europe/Moscow');
      expect(msg).toContain('UTC');
      expect(msg).toContain('Обновить часовой пояс?');
      const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { parse_mode: string; reply_markup: unknown };
      expect(opts.parse_mode).toBe('HTML');
      expect(opts.reply_markup).toBeDefined();
    });

    test('sends same-timezone message when location matches current timezone', async () => {
      const handler = createMessageHandler(makeHandlerDeps());
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'ru', timezone: 'Europe/Moscow', onboarding_completed: 1 }),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Europe/Moscow');
      expect(msg).toContain('уже');
    });

    test('does not route to AI agent after handling location', async () => {
      const deps = makeHandlerDeps();
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(NEW_YORK),
      });
      await handler(ctx);

      expect(deps.agent.run).toHaveBeenCalledTimes(0);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Update timezone?');
    });

    test('ignores location messages in group chats', async () => {
      const deps = makeHandlerDeps();
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'ru', timezone: 'UTC', onboarding_completed: 1 }),
        chatId: -100,
        chat: telegramChat('supergroup', -100),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      expect(ctx.send).not.toHaveBeenCalled();
      expect(deps.agent.run).not.toHaveBeenCalled();
    });

    test('always persists pin to pendingGeoStore even in default timezone path', async () => {
      const setMock = mock(() => Promise.resolve());
      const deps = makeHandlerDeps({
        pendingGeoStore: {
          set: setMock,
          get: mock(() => Promise.resolve(null)),
          delete: mock(() => Promise.resolve()),
        },
      });
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(NEW_YORK),
      });
      await handler(ctx);

      expect(setMock).toHaveBeenCalledTimes(1);
      const call = setMock.mock.calls[0] as unknown as [number, SharedLocation];
      expect(call[0]).toBe(100);
      expect(call[1]).toEqual({ latitude: 40.7128, longitude: -74.006, venue: null });
    });

    test('shows event-specific buttons when user has a recent unverified event', async () => {
      const recentEvent = agendaEvent({
        id: 42,
        title: 'Lunch',
        location: 'Cafe near work',
        location_verified: 0,
        created_at: new Date().toISOString(),
      });
      const recentSetMock = mock(() => Promise.resolve());
      const deps = makeHandlerDeps({
        eventService: stub({
          getEventsInRange: mock(() => []),
          getLatestCreated: mock(() => recentEvent),
        }),
        locationVerification: stub({ verifyEventLocation: mock(() => Promise.resolve(UNRESOLVED)) }),
        pendingGeoStore: {
          set: recentSetMock,
          get: mock(() => Promise.resolve(null)),
          delete: mock(() => Promise.resolve()),
        },
      });
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Lunch');
      const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { reply_markup: unknown };
      expect(opts.reply_markup).toBeDefined();
      // Pin should be persisted for the callback handler
      expect(recentSetMock).toHaveBeenCalledTimes(1);
    });

    test('does NOT show event-specific UI when latest event is already verified', async () => {
      const verifiedEvent = agendaEvent({
        id: 42,
        title: 'Lunch',
        location: 'Cafe',
        location_verified: 1,
        created_at: new Date().toISOString(),
      });
      const verifiedSetMock = mock(() => Promise.resolve());
      const deps = makeHandlerDeps({
        eventService: stub({
          getEventsInRange: mock(() => []),
          getLatestCreated: mock(() => verifiedEvent),
        }),
        locationVerification: stub({ verifyEventLocation: mock(() => Promise.resolve(UNRESOLVED)) }),
        pendingGeoStore: {
          set: verifiedSetMock,
          get: mock(() => Promise.resolve(null)),
          delete: mock(() => Promise.resolve()),
        },
      });
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      // Falls through to timezone update flow, but pin still persisted
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).not.toContain('Lunch');
      expect(verifiedSetMock).toHaveBeenCalledTimes(1);
    });

    test('does NOT show event-specific UI when latest event is older than 30 minutes', async () => {
      const oldEvent = agendaEvent({
        id: 42,
        title: 'Lunch',
        location: 'Cafe',
        location_verified: 0,
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
      });
      const deps = makeHandlerDeps({
        eventService: stub({
          getEventsInRange: mock(() => []),
          getLatestCreated: mock(() => oldEvent),
        }),
        locationVerification: stub({ verifyEventLocation: mock(() => Promise.resolve(UNRESOLVED)) }),
        pendingGeoStore: {
          set: mock(() => Promise.resolve()),
          get: mock(() => Promise.resolve(null)),
          delete: mock(() => Promise.resolve()),
        },
      });
      const handler = createMessageHandler(deps);
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(MOSCOW),
      });
      await handler(ctx);

      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).not.toContain('Lunch');
    });
  });

  describe('pin prompt for a recent unverified event', () => {
    const PIN = { latitude: 48.8566, longitude: 2.3522 };

    function makeGeoStore(): PendingGeoStore {
      const pins = new Map<number, SharedLocation>();
      return {
        set: async (userId, data) => {
          pins.set(userId, data);
        },
        get: async (userId) => pins.get(userId) ?? null,
        delete: async (userId) => {
          pins.delete(userId);
        },
      };
    }

    async function sendPin(title: string, geoStore: PendingGeoStore, verification: LocationVerificationService) {
      const event = agendaEvent({
        id: 42,
        title,
        location: 'Somewhere downtown',
        location_verified: 0,
        created_at: new Date().toISOString(),
      });
      const deps = makeHandlerDeps({
        eventService: stub({ getEventsInRange: mock(() => []), getLatestCreated: mock(() => event) }),
        locationVerification: verification,
        pendingGeoStore: geoStore,
      });
      const ctx = makeMessageCtx({
        text: undefined,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 }),
        location: new Location(PIN),
      });
      await createMessageHandler(deps)(ctx);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [text, opts] = ctx.send.mock.calls[0] as unknown as [
        string,
        { parse_mode: string; reply_markup: { toJSON(): { inline_keyboard: { callback_data: string }[][] } } },
      ];
      return { text, opts };
    }

    async function pressButton(
      callbackData: string,
      geoStore: PendingGeoStore,
      verification: LocationVerificationService,
    ) {
      const handler = createCallbackHandler(stub({}), stub({}), stub({}), stub({}), {
        locationVerification: verification,
        pendingGeoStore: geoStore,
        userRepo: stub({}),
      });
      const answer = mock<BotCallbackContext['answer']>(() => Promise.resolve(true as const));
      const ctx = stub<BotCallbackContext>({
        data: callbackData,
        chatId: 100,
        dbUser: makeUserRow({ telegram_id: 100, language: 'en', timezone: 'UTC' }),
        answer,
        editText: mock(() => Promise.resolve(sentMessage())),
      });
      await handler(ctx);
      // The router turns a handler error into an alert answer; only the plain acknowledgement is expected.
      expect(answer.mock.calls).toEqual([[]]);
    }

    test('HTML-escapes a title containing & and < so Telegram accepts the prompt', async () => {
      const { text, opts } = await sendPin(
        'Q&A <meetup>',
        makeGeoStore(),
        stub({ resolveFromSharedLocation: mock(() => Promise.resolve(false)) }),
      );
      expect(opts.parse_mode).toBe('HTML');
      expect(text).toContain('Q&amp;A &lt;meetup&gt;');
      expect(text).not.toContain('Q&A');
      expect(text).not.toContain('<meetup>');
    });

    test('shows a plain title unchanged and its confirm button attaches the pin to that event', async () => {
      const geoStore = makeGeoStore();
      const resolveFromSharedLocation = mock<LocationVerificationService['resolveFromSharedLocation']>(() =>
        Promise.resolve(false),
      );
      const verification = stub<LocationVerificationService>({ resolveFromSharedLocation });
      const { text, opts } = await sendPin('Team lunch', geoStore, verification);
      expect(text).toBe('📍 Got your location! Is this for the event "Team lunch"?');

      const confirm = opts.reply_markup.toJSON().inline_keyboard[0]?.[0];
      if (!confirm) throw new Error('prompt has no confirm button');
      await pressButton(confirm.callback_data, geoStore, verification);

      expect(resolveFromSharedLocation).toHaveBeenCalledTimes(1);
      expect(resolveFromSharedLocation.mock.calls[0]).toEqual([42, { ...PIN, venue: null }, 100]);
    });
  });
});
