import { describe, expect, mock, test } from 'bun:test';
import type { Bot, InlineKeyboard } from 'gramio';
import { createTelegramSender } from '../../../src/services/ai/telegram-sender.ts';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';

interface CapturedButton {
  text: string;
  callback_data?: string;
}

/** Read gramio's InlineKeyboard internal rows. Centralized test-only cast (bun:test pattern). */
function keyboardButtons(kb: InlineKeyboard): CapturedButton[] {
  const rows = (kb as unknown as { keyboard: CapturedButton[][] }).keyboard;
  return rows.flat();
}

interface SendMessageArgs {
  chat_id: number;
  text: string;
  reply_markup?: InlineKeyboard;
}

function makeSender() {
  const calls: SendMessageArgs[] = [];
  const sendMessage = mock((args: SendMessageArgs) => {
    calls.push(args);
    return Promise.resolve({ message_id: 1 });
  });
  const bot = { api: { sendMessage } } as unknown as Bot;
  return { sender: createTelegramSender(bot), calls };
}

describe('createTelegramSender.sendInvitation', () => {
  test('personal variant sends the canonical RSVP keyboard', async () => {
    const { sender, calls } = makeSender();
    await sender.sendInvitation!(123, 'You are invited', 7, 'ru', { kind: 'personal', place: null });

    expect(calls[0]!.reply_markup!.toJSON()).toEqual(invitationRsvpKeyboard(7, 'ru', null).toJSON());
  });

  test('group variant builds the grsvp: per-member keyboard keyed by eventId', async () => {
    const { sender, calls } = makeSender();
    await sender.sendInvitation!(456, 'Group event', 7, 'ru', { kind: 'group', eventId: 42, place: null });

    const buttons = keyboardButtons(calls[0]!.reply_markup!);
    const data = buttons.map((b) => b.callback_data ?? '');
    expect(data).toContain('grsvp:42:going');
    expect(data).toContain('grsvp:42:notgoing');
    // No personal invitation buttons must leak into the group keyboard.
    expect(data.some((d) => d.startsWith('inv:'))).toBe(false);
  });
});
