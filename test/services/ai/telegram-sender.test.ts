import { describe, expect, mock, test } from 'bun:test';
import type { Bot, InlineKeyboard } from 'gramio';
import { createTelegramSender } from '../../../src/services/ai/telegram-sender.ts';
import { invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';
import { cyrillicOption, TELEGRAM_CALLBACK_DATA_MAX_BYTES } from '../../helpers/ask-user-keyboard.ts';

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

describe('createTelegramSender.sendButtons', () => {
  for (const userId of [undefined, 1001]) {
    for (const length of [20, 30, 60, 200]) {
      test(`a ${length}-character Cyrillic option ${userId ? 'in a group' : 'in a private chat'} fits Telegram's callback_data limit`, async () => {
        const { sender, calls } = makeSender();
        const option = cyrillicOption(length);
        await sender.sendButtons!(5, 'Вопрос?', [option], 'HTML', userId);

        const [button] = keyboardButtons(calls[0]!.reply_markup!);
        expect(button!.text).toBe(option);
        expect(Buffer.byteLength(button!.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(
          TELEGRAM_CALLBACK_DATA_MAX_BYTES,
        );
      });
    }
  }

  // Buttons already sitting in chats carry these exact payloads, so the short form must not change.
  test('a short option keeps the ai_btn payload, with the asker prefix in a group', async () => {
    const { sender, calls } = makeSender();
    await sender.sendButtons!(5, 'Вопрос?', ['Да', '19:00'], 'HTML');
    await sender.sendButtons!(5, 'Вопрос?', ['Да', '19:00'], 'HTML', 1001);

    expect(keyboardButtons(calls[0]!.reply_markup!).map((b) => b.callback_data)).toEqual(['ai_btn:Да', 'ai_btn:19:00']);
    expect(keyboardButtons(calls[1]!.reply_markup!).map((b) => b.callback_data)).toEqual([
      'ai_btn:1001:Да',
      'ai_btn:1001:19:00',
    ]);
  });

  test('a long option rides as its index under a separate action, next to short ones', async () => {
    const { sender, calls } = makeSender();
    const options = ['Да', cyrillicOption(60), 'Нет'];
    await sender.sendButtons!(5, 'Вопрос?', options, 'HTML');
    await sender.sendButtons!(5, 'Вопрос?', options, 'HTML', 1001);

    expect(keyboardButtons(calls[0]!.reply_markup!).map((b) => b.callback_data)).toEqual([
      'ai_btn:Да',
      'ai_opt:1',
      'ai_btn:Нет',
    ]);
    expect(keyboardButtons(calls[1]!.reply_markup!).map((b) => b.callback_data)).toEqual([
      'ai_btn:1001:Да',
      'ai_opt:1001:1',
      'ai_btn:1001:Нет',
    ]);
  });

  // 'ai_btn:' is 7 bytes and a Cyrillic letter 2: the limit is bytes, not characters.
  test('the payload switches form exactly at 64 bytes', async () => {
    const { sender, calls } = makeSender();
    const fits = `${'я'.repeat(28)}x`;
    const overByOne = `${'я'.repeat(28)}xx`;
    await sender.sendButtons!(5, 'Вопрос?', [fits, overByOne], 'HTML');

    expect(keyboardButtons(calls[0]!.reply_markup!).map((b) => b.callback_data)).toEqual([
      `ai_btn:${fits}`,
      'ai_opt:1',
    ]);
  });

  test('long options that differ only in their tail stay distinct buttons', async () => {
    const { sender, calls } = makeSender();
    const shared = cyrillicOption(60);
    await sender.sendButtons!(5, 'Вопрос?', [`${shared} (первый)`, `${shared} (второй)`], 'HTML');

    const data = keyboardButtons(calls[0]!.reply_markup!).map((b) => b.callback_data);
    expect(new Set(data).size).toBe(2);
  });
});
