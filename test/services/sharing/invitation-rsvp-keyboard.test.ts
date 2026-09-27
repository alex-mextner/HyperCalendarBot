import { describe, expect, test } from 'bun:test';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';

describe('invitationRsvpKeyboard', () => {
  test('builds Accept/Decline and Maybe/Other time rows keyed by invitation id (en)', () => {
    expect(invitationRsvpKeyboard(128, 'en').toJSON()).toEqual({
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

  test('localizes only the propose button label (ru)', () => {
    expect(invitationRsvpKeyboard(7, 'ru').toJSON()).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Accept', callback_data: 'inv:accept:7' },
          { text: '❌ Decline', callback_data: 'inv:decline:7' },
        ],
        [
          { text: 'Maybe 🤔', callback_data: 'inv:maybe:7' },
          { text: 'Другое время 🕐', callback_data: 'inv:propose:7' },
        ],
      ],
    });
  });
});
