import { describe, expect, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import type { EventPlace } from '../../../src/services/location/event-venue.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';

const CONFIRMED_PLACE: EventPlace = {
  id: 642,
  title: 'Встреча',
  location: 'Kafana Sunce',
  venue_name: 'Kafana Sunce',
  resolved_address: 'Dunavska 1, Белград',
  latitude: 44.8231,
  longitude: 20.4632,
  location_verified: 1,
};
const UNCONFIRMED_PLACE: EventPlace = {
  ...CONFIRMED_PLACE,
  venue_name: null,
  resolved_address: null,
  latitude: null,
  longitude: null,
  location_verified: 0,
};

describe('invitationRsvpKeyboard', () => {
  test('builds Accept/Decline and Maybe/Other time rows keyed by invitation id (en)', () => {
    expect(invitationRsvpKeyboard(128, 'en', null).toJSON()).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Accept', callback_data: 'inv:accept:128' },
          { text: '❌ Decline', callback_data: 'inv:decline:128' },
        ],
        [
          { text: 'Maybe 🤔', callback_data: 'inv:maybe:128' },
          { text: 'Other time 🕐', callback_data: 'inv:propose:128' },
        ],
      ],
    });
  });

  test('labels all four buttons in Russian for a ru invitee, keeping the callback data (#727)', () => {
    expect(invitationRsvpKeyboard(7, 'ru', UNCONFIRMED_PLACE).toJSON()).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Принять', callback_data: 'inv:accept:7' },
          { text: '❌ Отклонить', callback_data: 'inv:decline:7' },
        ],
        [
          { text: 'Возможно 🤔', callback_data: 'inv:maybe:7' },
          { text: 'Другое время 🕐', callback_data: 'inv:propose:7' },
        ],
      ],
    });
  });

  test('an event with a confirmed place adds the Map row, keyed by event id', () => {
    expect(invitationRsvpKeyboard(7, 'ru', CONFIRMED_PLACE).toJSON().inline_keyboard.at(-1)).toEqual([
      { text: t('ru').event_map_btn, callback_data: 'ev_map:642' },
    ]);
  });
});

describe('groupRsvpKeyboard', () => {
  test('builds one Going/Not going row keyed by event id, so any member can answer', () => {
    expect(groupRsvpKeyboard(642, 'ru', UNCONFIRMED_PLACE).toJSON()).toEqual({
      inline_keyboard: [
        [
          { text: t('ru').group_rsvp_going_btn, callback_data: 'grsvp:642:going' },
          { text: t('ru').group_rsvp_notgoing_btn, callback_data: 'grsvp:642:notgoing' },
        ],
      ],
    });
  });

  test('an event with a confirmed place adds the Map row', () => {
    expect(groupRsvpKeyboard(642, 'en', CONFIRMED_PLACE).toJSON().inline_keyboard).toEqual([
      [
        { text: t('en').group_rsvp_going_btn, callback_data: 'grsvp:642:going' },
        { text: t('en').group_rsvp_notgoing_btn, callback_data: 'grsvp:642:notgoing' },
      ],
      [{ text: t('en').event_map_btn, callback_data: 'ev_map:642' }],
    ]);
  });
});
