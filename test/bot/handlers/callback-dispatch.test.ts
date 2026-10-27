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
import type { CallbackDispatch, CallbackRouteDeps } from '../../../src/bot/handlers/callback/types';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';
import { CB } from '../../../src/config/constants';

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
  return { eventService: {}, editValueScene: {}, holidayService: {}, prefsService: {}, opts: {} } as never;
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

function makeCtx(data: string, user: { telegram_id: number; language: string } | undefined) {
  return {
    data,
    dbUser: user,
    from: { languageCode: 'ru' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
  };
}

const USER = { telegram_id: 100, language: 'en' };

function makeHandler(opts: Parameters<typeof createCallbackHandler>[4] = {}, eventService: object = {}) {
  return createCallbackHandler(eventService as never, {} as never, {} as never, {} as never, opts);
}

describe('callback router fallbacks', () => {
  test('a prefix match must be exact, not a leading substring of a known prefix', async () => {
    const ctx = makeCtx(`${CB.EVENT_VIEW}_extra:1`, USER);
    await makeHandler()(ctx as never);
    // Unknown action: acknowledged only, no editText from the event view route.
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('unknown action with a stored scene pauses the scene and sends the help prompt', async () => {
    const save = mock(() => Promise.resolve());
    const get = mock(() => Promise.resolve(JSON.stringify({ name: 'timezone', step: 2, state: { city: 'Berlin' } })));
    const handler = makeHandler({
      scenePauseDeps: { sceneStorage: { get }, scenePauseService: { save } },
    } as never);
    const ctx = makeCtx('totally_unknown:1', USER);
    await handler(ctx as never);

    expect(get).toHaveBeenCalledWith('@gramio/scenes:100');
    expect(save).toHaveBeenCalledWith(100, { sceneName: 'timezone', step: 2, sceneState: { city: 'Berlin' } });
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('unknown action with an unparseable stored scene still sends the help prompt without pausing', async () => {
    const save = mock(() => Promise.resolve());
    const handler = makeHandler({
      scenePauseDeps: { sceneStorage: { get: () => Promise.resolve('not json') }, scenePauseService: { save } },
    } as never);
    const ctx = makeCtx('totally_unknown', USER);
    await handler(ctx as never);

    expect(save).not.toHaveBeenCalled();
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  test('unknown action with no stored scene sends nothing beyond the answer', async () => {
    const handler = makeHandler({
      scenePauseDeps: { sceneStorage: { get: () => Promise.resolve(undefined) }, scenePauseService: { save: mock() } },
    } as never);
    const ctx = makeCtx('totally_unknown', USER);
    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('no resolved user: a group RSVP tap gets a start hint alert, other taps are dropped', async () => {
    const rsvp = makeCtx(`${CB.GROUP_RSVP}:yes:1`, undefined);
    await makeHandler()(rsvp as never);
    expect(rsvp.answer).toHaveBeenCalledTimes(1);
    const arg = (rsvp.answer.mock.calls[0] as unknown as [{ show_alert: boolean }])[0];
    expect(arg.show_alert).toBe(true);

    const other = makeCtx(`${CB.EVENT_VIEW}:1`, undefined);
    await makeHandler()(other as never);
    expect(other.answer).not.toHaveBeenCalled();
  });

  test('a handler failure answers with the generic error text; a duplicate-click failure answers silently', async () => {
    const failing = makeCtx(`${CB.EVENT_VIEW}:1`, USER);
    const boom = makeHandler(
      {},
      {
        getEvent: () => {
          throw new Error('db down');
        },
      },
    );
    await boom(failing as never);
    expect(failing.answer).toHaveBeenCalledTimes(1);
    expect((failing.answer.mock.calls[0] as unknown as [{ text: string }])[0].text).toBeTruthy();

    const dup = makeCtx(`${CB.EVENT_VIEW}:1`, USER);
    const notModified = makeHandler(
      {},
      {
        getEvent: () => {
          throw new Error('Bad Request: message is not modified');
        },
      },
    );
    await notModified(dup as never);
    expect(dup.answer).toHaveBeenCalledTimes(1);
    expect(dup.answer.mock.calls[0] as unknown[]).toEqual([]);
  });
});
