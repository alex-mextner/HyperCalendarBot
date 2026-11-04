// ask_user delivery: what Telegram can carry reaches the user, what it cannot is named to the model.
// Incident 2026-10-31: two options of 45 and 22 characters made the whole question fail with
// BUTTON_DATA_INVALID and the model never got to ask.

import { describe, expect, mock, test } from 'bun:test';
import { MAX_ASK_USER_OPTIONS } from '../../../../src/services/ai/ask-user-buttons.ts';
import { handleAskUser } from '../../../../src/services/ai/tool-handlers/meta.ts';
import type { TelegramSender } from '../../../../src/services/ai/types.ts';
import { cyrillicOption, fakeTelegram, TELEGRAM_CALLBACK_DATA_MAX_BYTES } from '../../../helpers/ask-user-keyboard.ts';
import { agentContext, userRow } from '../context-fixtures.ts';

const ASKER = 2002;
const QUESTION = 'Как поступить?';
const INCIDENT_OPTIONS = ['Создать у меня и пригласить Ольгу, Сэма, Кима', 'Оставить только у Ольги'];

function askerContext(overrides: Parameters<typeof agentContext>[0] = {}) {
  return agentContext({ user: userRow({ telegram_id: ASKER, language: 'ru' }), chatId: ASKER, ...overrides });
}

/** A sender that records the buttons it was asked to show and fails the way Telegram does when told to. */
function recordingSender(failWith?: Error) {
  const sendButtons = mock<NonNullable<TelegramSender['sendButtons']>>(() =>
    failWith ? Promise.reject(failWith) : Promise.resolve({ message_id: 1 }),
  );
  const sender: TelegramSender = {
    sendMessage: () => Promise.resolve({ message_id: 1 }),
    editMessageText: () => Promise.resolve(),
    sendButtons,
  };
  return { sender, sendButtons };
}

describe('handleAskUser delivers what Telegram can carry', () => {
  test.each([
    ['private chat', false],
    ['group', true],
  ])('the incident question (%s) is delivered with every button inside the callback_data limit', async (_chat, isGroup) => {
    const { sender, sent } = fakeTelegram();

    const result = await handleAskUser(askerContext({ sender, isGroup }), {
      question: QUESTION,
      options: INCIDENT_OPTIONS,
    });

    expect(result.success).toBe(true);
    expect(result.stopLoop).toBe(true);
    const buttons = sent[0]!.inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual([...INCIDENT_OPTIONS, 'Отмена']);
    for (const button of buttons) {
      expect(Buffer.byteLength(button.callback_data ?? '', 'utf8')).toBeLessThanOrEqual(
        TELEGRAM_CALLBACK_DATA_MAX_BYTES,
      );
    }
  });

  test('the largest keyboard Telegram is trusted with is delivered', async () => {
    const { sender, sent } = fakeTelegram();
    const options = Array.from({ length: MAX_ASK_USER_OPTIONS - 1 }, (_unused, index) => `Вариант ${index + 1}`);

    const result = await handleAskUser(askerContext({ sender }), { question: QUESTION, options });

    expect(result.success).toBe(true);
    expect(sent[0]!.inline_keyboard.flat()).toHaveLength(MAX_ASK_USER_OPTIONS);
  });

  test('a model that sent Cancel itself may use all 100 buttons; one more is refused counting Cancel once', async () => {
    const { sender, sent } = fakeTelegram();
    const withCancel = [...Array.from({ length: MAX_ASK_USER_OPTIONS - 1 }, (_u, i) => `Вариант ${i + 1}`), 'Отмена'];
    const ok = await handleAskUser(askerContext({ sender }), { question: QUESTION, options: withCancel });
    expect(ok.success).toBe(true);
    expect(sent[0]!.inline_keyboard.flat()).toHaveLength(MAX_ASK_USER_OPTIONS);
    const tooMany = await handleAskUser(askerContext({ sender }), {
      question: QUESTION,
      options: [...withCancel, 'Ещё'],
    });
    expect(tooMany.success).toBe(false);
    expect(tooMany.error).toContain(`${MAX_ASK_USER_OPTIONS + 1} options do not fit`);
    expect(sent).toHaveLength(1);
  });

  // No label-length limit is enforced: a 3000-character option is delivered whole. Whether Telegram
  // itself shows a very long label whole is unverified (#914).
  test('long labels are delivered whole, not rejected', async () => {
    const { sender, sent } = fakeTelegram();
    const options = [cyrillicOption(200).repeat(15), ...Array.from({ length: 15 }, () => cyrillicOption(300))];

    const result = await handleAskUser(askerContext({ sender }), { question: QUESTION, options });

    expect(result.success).toBe(true);
    expect(sent[0]!.inline_keyboard.flat().map((button) => button.text)).toEqual([...options, 'Отмена']);
  });
});

describe('handleAskUser names what Telegram cannot carry', () => {
  test.each([
    ['an empty option', { question: QUESTION, options: ['Да', ''] }, 'option 2 is empty'],
    ['a whitespace-only option', { question: QUESTION, options: ['  ', 'Нет'] }, 'option 1 is empty'],
    ['an empty question', { question: '   ', options: ['Да', 'Нет'] }, 'the question is empty'],
    [
      'more options than a keyboard holds',
      {
        question: QUESTION,
        options: Array.from({ length: MAX_ASK_USER_OPTIONS }, (_unused, index) => `Вариант ${index + 1}`),
      },
      `${MAX_ASK_USER_OPTIONS} options plus the "Отмена" button this tool adds itself do not fit on one Telegram keyboard (at most ${MAX_ASK_USER_OPTIONS} buttons: ${MAX_ASK_USER_OPTIONS - 1} of your options)`,
    ],
  ])('%s is returned to the model and nothing is sent', async (_case, input, problem) => {
    const { sender, sendButtons } = recordingSender();

    const result = await handleAskUser(askerContext({ sender }), input);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ASK_USER_INVALID_INPUT');
    expect(result.error).toContain(problem);
    expect(sendButtons).not.toHaveBeenCalled();
  });
});

describe('handleAskUser when Telegram refuses the question anyway', () => {
  test('the tool result carries no Telegram wording for the user to see', async () => {
    const { sender } = recordingSender(new Error('Bad Request: BUTTON_DATA_INVALID'));

    const result = await handleAskUser(askerContext({ sender }), { question: QUESTION, options: ['Да', 'Нет'] });

    expect(result.success).toBe(false);
    expect(result.error).toStartWith('ASK_USER_DELIVERY_FAILED');
    expect(result.error).not.toContain('BUTTON_DATA_INVALID');
  });
});
