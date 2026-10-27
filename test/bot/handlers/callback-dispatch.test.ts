// Pins the callback router's prefix table: which route group owns which callback-data prefix, that no
// two groups claim the same prefix (a later registration would silently shadow the earlier one), and
// the router's fallback paths around the table (unknown prefix, missing user, handler failure).

import { describe, expect, mock, test } from 'bun:test';
import { registerAdminRoutes } from '../../../src/bot/handlers/callback/admin-routes';
import { registerAgendaRoutes } from '../../../src/bot/handlers/callback/agenda-routes';
import { registerAiRoutes } from '../../../src/bot/handlers/callback/ai-routes';
import { registerEventRoutes } from '../../../src/bot/handlers/callback/event-routes';
import { registerInvitationRoutes } from '../../../src/bot/handlers/callback/invitation-routes';
import { registerInviteRoutes } from '../../../src/bot/handlers/callback/invite-routes';
import { registerLocationRoutes } from '../../../src/bot/handlers/callback/location-routes';
import { registerProposalRoutes } from '../../../src/bot/handlers/callback/proposal-routes';
import { registerSettingsRoutes } from '../../../src/bot/handlers/callback/settings-routes';
import type {
  CallbackDispatch,
  CallbackHandlerOpts,
  CallbackRouteDeps,
} from '../../../src/bot/handlers/callback/types';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';
import type { BotCallbackContext } from '../../../src/bot/types.ts';
import { CB, t } from '../../../src/config/constants';
import type { User } from '../../../src/database/types.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage, telegramUser } from '../telegram-fixtures.ts';

type Registrar = (dispatch: CallbackDispatch, deps: CallbackRouteDeps) => void;

const ROUTE_GROUPS: Array<{ name: string; register: Registrar; prefixes: string[] }> = [
  { name: 'ai', register: registerAiRoutes, prefixes: ['ric', 'dlc', CB.SCENE_HELP, 'ai_btn'] },
  {
    name: 'event',
    register: registerEventRoutes,
    prefixes: [
      CB.EVENT_VIEW,
      CB.EVENT_EDIT,
      CB.EDIT_FIELD,
      CB.EVENT_DELETE,
      CB.EVENT_DELETE_CONFIRM,
      CB.EVENT_RECURRENCE,
      CB.RECURRENCE_DELETE,
      CB.MONTH_NAV,
      CB.NOTIFY,
      CB.HOLIDAYS,
      CB.GCAL,
      'snooze',
    ],
  },
  { name: 'agenda', register: registerAgendaRoutes, prefixes: [CB.IMG_DAILY, CB.IMG_WEEKLY, CB.SHARE_EVENT] },
  { name: 'invitation', register: registerInvitationRoutes, prefixes: [CB.INVITATION_ACTION, CB.GROUP_RSVP] },
  { name: 'proposal', register: registerProposalRoutes, prefixes: [CB.EDIT_PROPOSAL, 'sec', 'prop'] },
  {
    name: 'invite',
    register: registerInviteRoutes,
    prefixes: [CB.INVITE_PICK, CB.INVITE_CONTACT, CB.INV_FORCE, CB.INV_RETIME, CB.INV_CANCEL],
  },
  {
    name: 'settings',
    register: registerSettingsRoutes,
    prefixes: [
      CB.FEATURE_TOUR,
      'stg',
      CB.GEO_TZ_CONFIRM,
      CB.GEO_TZ_DISMISS,
      CB.GROUP_SETTINGS_TZ,
      'voice_prompt',
      CB.CT_TZ_UPDATE,
      CB.CT_TZ_SKIP,
      CB.CT_TZ_CONSENT_YES,
      CB.CT_TZ_CONSENT_NO,
    ],
  },
  {
    name: 'location',
    register: registerLocationRoutes,
    prefixes: [CB.LOCATION_GEO, CB.LOCATION_CANDIDATE, CB.EVENT_MAP],
  },
  {
    name: 'admin',
    register: registerAdminRoutes,
    prefixes: ['fb_close', 'fb_reply', 'intent_accept', 'intent_reject', 'intent_edit'],
  },
];

function routeDeps(): CallbackRouteDeps {
  return {
    eventService: stub({}),
    editValueScene: stub({}),
    holidayService: stub({}),
    prefsService: stub({}),
    opts: {},
  };
}

describe('callback prefix table', () => {
  for (const group of ROUTE_GROUPS) {
    test(`${group.name} routes register exactly their prefixes`, () => {
      const dispatch: CallbackDispatch = new Map();
      group.register(dispatch, routeDeps());
      expect([...dispatch.keys()].sort()).toEqual([...group.prefixes].sort());
    });
  }

  test('no prefix is claimed by two route groups', () => {
    const owners = new Map<string, string>();
    for (const group of ROUTE_GROUPS) {
      for (const prefix of group.prefixes) {
        expect(owners.get(prefix)).toBeUndefined();
        owners.set(prefix, group.name);
      }
    }
    expect(owners.size).toBe(47);
  });
});

function makeCtx(data: string, user: User | undefined) {
  return {
    data,
    dbUser: user,
    from: telegramUser({ id: 1, language_code: 'ru' }),
    answer: mock<BotCallbackContext['answer']>(() => Promise.resolve(true as const)),
    editText: mock(() => Promise.resolve(sentMessage())),
    send: mock(() => Promise.resolve(sentMessage())),
  };
}

const USER = makeUserRow({ telegram_id: 100, language: 'en' });

function makeHandler(opts: CallbackHandlerOpts = {}, eventService: Partial<EventService> = {}) {
  return createCallbackHandler(stub(eventService), stub({}), stub({}), stub({}), opts);
}

describe('callback router fallbacks', () => {
  test('a prefix match must be exact, not a leading substring of a known prefix', async () => {
    const ctx = makeCtx(`${CB.EVENT_VIEW}_extra:1`, USER);
    await makeHandler()(stub(ctx));
    // Unknown action: acknowledged only, no editText from the event view route.
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.answer.mock.calls[0]).toEqual([]);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('unknown action with a stored scene pauses the scene and sends the help prompt', async () => {
    const save = mock(() => Promise.resolve());
    const get = mock(() => Promise.resolve(JSON.stringify({ name: 'timezone', step: 2, state: { city: 'Berlin' } })));
    const handler = makeHandler({
      scenePauseDeps: { sceneStorage: stub({ get }), scenePauseService: stub({ save }) },
    });
    const ctx = makeCtx('totally_unknown:1', USER);
    await handler(stub(ctx));

    expect(get).toHaveBeenCalledWith('@gramio/scenes:100');
    expect(save).toHaveBeenCalledWith(100, { sceneName: 'timezone', step: 2, sceneState: { city: 'Berlin' } });
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('unknown action with an unparseable stored scene still sends the help prompt without pausing', async () => {
    const save = mock(() => Promise.resolve());
    const handler = makeHandler({
      scenePauseDeps: {
        sceneStorage: stub({ get: () => Promise.resolve('not json') }),
        scenePauseService: stub({ save }),
      },
    });
    const ctx = makeCtx('totally_unknown', USER);
    await handler(stub(ctx));

    expect(save).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('unknown action with no stored scene sends nothing beyond the answer', async () => {
    const handler = makeHandler({
      scenePauseDeps: {
        sceneStorage: stub({ get: () => Promise.resolve(undefined) }),
        scenePauseService: stub({ save: mock(() => Promise.resolve()) }),
      },
    });
    const ctx = makeCtx('totally_unknown', USER);
    await handler(stub(ctx));

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.answer.mock.calls[0]).toEqual([]);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('no resolved user: a group RSVP tap gets a start hint alert, other taps are dropped', async () => {
    const rsvp = makeCtx(`${CB.GROUP_RSVP}:yes:1`, undefined);
    await makeHandler()(stub(rsvp));
    expect(rsvp.answer).toHaveBeenCalledTimes(1);
    // No resolved user: the hint language comes from the tapper's Telegram client language ('ru' in makeCtx).
    expect(rsvp.answer.mock.calls[0]?.[0]).toEqual({ text: t('ru').group_rsvp_start_hint, show_alert: true });

    const other = makeCtx(`${CB.EVENT_VIEW}:1`, undefined);
    await makeHandler()(stub(other));
    expect(other.answer).not.toHaveBeenCalled();
  });

  test('a handler failure answers with the generic error text; a duplicate-click failure answers silently', async () => {
    const failing = makeCtx(`${CB.EVENT_VIEW}:1`, USER);
    const failingLookup = mock(() => {
      throw new Error('db down');
    });
    const boom = makeHandler({}, { getEvent: failingLookup });
    await boom(stub(failing));
    expect(failingLookup).toHaveBeenCalledTimes(1);
    expect(failing.answer).toHaveBeenCalledTimes(1);
    expect(failing.answer.mock.calls[0]?.[0]).toMatchObject({ text: expect.stringMatching(/\S/) });

    const dup = makeCtx(`${CB.EVENT_VIEW}:1`, USER);
    const staleLookup = mock(() => {
      throw new Error('Bad Request: message is not modified');
    });
    const notModified = makeHandler({}, { getEvent: staleLookup });
    await notModified(stub(dup));
    expect(staleLookup).toHaveBeenCalledTimes(1);
    expect(dup.answer).toHaveBeenCalledTimes(1);
    expect(dup.answer.mock.calls[0]).toEqual([]);
  });
});
