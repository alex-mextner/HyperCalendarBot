// ask_user answers of any length: the real sender builds the keyboard on a Telegram that refuses
// callback_data over 64 bytes, and the real tap handler turns each tap back into the exact option
// text. A 45-character option (87 bytes with its prefix, the synthetic "Создать у меня и пригласить
// Ольгу, Сэма, Кима") made the whole question undeliverable (BUTTON_DATA_INVALID).

import { describe, expect, mock, test } from 'bun:test';
import { InlineKeyboardMarkup, type TelegramInlineKeyboardMarkup } from 'gramio';
import type { CallbackHandlerOpts } from '../../../src/bot/handlers/callback/types.ts';
import { t } from '../../../src/config/constants.ts';
import { cyrillicOption, fakeTelegram } from '../../helpers/ask-user-keyboard.ts';
import { makeCallbackHandler, makeCallbackTap } from '../../helpers/callback-handler.ts';

const ASKER = 2002;
const OTHER_MEMBER = 3001;
const GROUP_CHAT = -100200;
const QUESTION = 'Как поступить?';
const INCIDENT_OPTIONS = ['Создать у меня и пригласить Ольгу, Сэма, Кима', 'Оставить только у Ольги', 'Отмена'];

type ButtonClick = NonNullable<CallbackHandlerOpts['onAiButtonClick']>;

interface TapSetting {
  by?: number;
  group?: boolean;
  /** Telegram's id of the tapped message. Each tap is a message of its own unless it names one: the answered-message memory is shared by every handler, so tests must not collide on ids. */
  messageId?: number;
  /** The text of the tapped message as Telegram returns it; an answered question ends in "✅ answer". */
  text?: string;
  /** The inline keyboard the tapped message still carries; absent once it was answered or is too old to be readable. */
  keyboard?: TelegramInlineKeyboardMarkup;
}

let lastMessageId = 1000;
function nextMessageId(): number {
  lastMessageId += 1;
  return lastMessageId;
}

function tap(
  data: string,
  { by = ASKER, group = false, text = QUESTION, keyboard, messageId = nextMessageId() }: TapSetting = {},
) {
  const { ctx, answer, editText } = makeCallbackTap(data, { telegram_id: by, language: 'ru' });
  const chatId = group ? GROUP_CHAT : by;
  Object.assign(ctx, {
    chatId,
    from: { id: by },
    message: {
      id: messageId,
      text,
      chat: { id: chatId, type: group ? 'supergroup' : 'private' },
      replyMarkup: keyboard && new InlineKeyboardMarkup(keyboard),
    },
  });
  return { ctx, answer, editText };
}

/** Asks `options` with the real sender and returns the keyboard the chat now shows. */
async function ask(options: string[], group: boolean): Promise<TelegramInlineKeyboardMarkup> {
  const { sender, sent } = fakeTelegram();
  await sender.sendButtons!(group ? GROUP_CHAT : ASKER, QUESTION, options, 'HTML', group ? ASKER : undefined);
  return sent[0]!;
}

function dataOfButton(keyboard: TelegramInlineKeyboardMarkup, index: number): string {
  return keyboard.inline_keyboard.flat()[index]!.callback_data!;
}

function setup() {
  const onAiButtonClick = mock<ButtonClick>(() => Promise.resolve());
  return { onAiButtonClick, handler: makeCallbackHandler({ onAiButtonClick }) };
}

describe('an ask_user option of any length reaches the AI unchanged', () => {
  for (const group of [false, true]) {
    for (const length of [20, 30, 60, 200]) {
      test(`${length} Cyrillic characters, ${group ? 'group' : 'private chat'}`, async () => {
        const option = cyrillicOption(length);
        const keyboard = await ask([option, 'Нет'], group);
        const { onAiButtonClick, handler } = setup();
        const { ctx, editText } = tap(dataOfButton(keyboard, 0), { group, keyboard });

        await handler(ctx);

        expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, group ? GROUP_CHAT : ASKER, option);
        expect(editText).toHaveBeenCalledWith(`${QUESTION}\n\n✅ ${option}`, { entities: [] });
      });

      test(`${length} Cyrillic characters: the short option beside it still answers, ${group ? 'group' : 'private chat'}`, async () => {
        const keyboard = await ask([cyrillicOption(length), 'Нет'], group);
        const { onAiButtonClick, handler } = setup();
        const { ctx, editText } = tap(dataOfButton(keyboard, 1), { group, keyboard });

        await handler(ctx);

        expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, group ? GROUP_CHAT : ASKER, 'Нет');
        expect(editText).toHaveBeenCalledWith(`${QUESTION}\n\n✅ Нет`, { entities: [] });
      });
    }
  }

  test.each(
    INCIDENT_OPTIONS.map((option, index) => [option, index] as const),
  )('incident question: "%s" is delivered and answered verbatim', async (option, index) => {
    const keyboard = await ask(INCIDENT_OPTIONS, false);
    const { onAiButtonClick, handler } = setup();
    const { ctx } = tap(dataOfButton(keyboard, index), { keyboard });

    await handler(ctx);

    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, option);
  });

  test('an option that looks like an index payload is still just text', async () => {
    const keyboard = await ask(['ai_opt:1', '1001:Да'], true);
    const { onAiButtonClick, handler } = setup();

    await handler(tap(dataOfButton(keyboard, 0), { group: true, keyboard }).ctx);
    expect(onAiButtonClick).toHaveBeenLastCalledWith(ASKER, GROUP_CHAT, 'ai_opt:1');
    await handler(tap(dataOfButton(keyboard, 1), { group: true, keyboard, messageId: 2 }).ctx);
    expect(onAiButtonClick).toHaveBeenLastCalledWith(ASKER, GROUP_CHAT, '1001:Да');
  });
});

// Messages already in chats were sent with these exact payloads.
describe('ask_user buttons sent before the index form keep working', () => {
  test('private ai_btn payload', async () => {
    const { onAiButtonClick, handler } = setup();
    await handler(tap('ai_btn:Да').ctx);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, 'Да');
  });

  test('group ai_btn payload, tapped by the asker', async () => {
    const { onAiButtonClick, handler } = setup();
    await handler(tap(`ai_btn:${ASKER}:19:00`, { group: true }).ctx);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, GROUP_CHAT, '19:00');
  });
});

describe('only the asking user may answer in a group', () => {
  test.each([
    ['a short option', 'Нет'],
    ['a long option', cyrillicOption(60)],
  ])('a tap by another member on %s is refused', async (_form, option) => {
    const keyboard = await ask([option, 'Нет'], true);
    const index = option === 'Нет' ? 1 : 0;
    const { onAiButtonClick, handler } = setup();
    const { ctx, answer, editText } = tap(dataOfButton(keyboard, index), { by: OTHER_MEMBER, group: true, keyboard });

    await handler(ctx);

    expect(answer).toHaveBeenCalledWith({ text: t('ru').callbackErrors.notYourQuestion, show_alert: false });
    expect(editText).not.toHaveBeenCalled();
    expect(onAiButtonClick).not.toHaveBeenCalled();
  });
});

describe('an index tap that cannot be read as an answer', () => {
  test('after the question was answered, a late tap is ignored quietly', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    // Answering edits the message without its keyboard, so a client still showing the buttons taps a message with none.
    const { ctx, answer, editText } = tap(dataOfButton(keyboard, 0), { text: `${QUESTION}\n\n✅ Нет` });

    await handler(ctx);

    expect(answer).toHaveBeenCalledWith();
    expect(editText).not.toHaveBeenCalled();
    expect(onAiButtonClick).not.toHaveBeenCalled();
  });

  test('on a message whose keyboard is no longer readable, the user is told and the AI is not run', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    const { ctx, answer, editText } = tap(dataOfButton(keyboard, 0));

    await handler(ctx);

    expect(answer).toHaveBeenCalledWith({ text: t('ru').callbackErrors.unavailable, show_alert: true });
    expect(editText).not.toHaveBeenCalled();
    expect(onAiButtonClick).not.toHaveBeenCalled();
  });

  test.each([
    'ai_opt:abc',
    'ai_opt:1:2:3',
    'ai_opt:',
  ])('malformed data %p is acknowledged and ignored', async (data) => {
    const { onAiButtonClick, handler } = setup();
    const { ctx, answer } = tap(data);

    await handler(ctx);

    expect(answer).toHaveBeenCalledWith();
    expect(onAiButtonClick).not.toHaveBeenCalled();
  });
});

// An acknowledgement the chat cannot take (over 4096 characters, or a failed edit) used to leave
// the buttons live and the message without "✅": the next tap then looked unanswered and the AI got
// a second continuation. The answer is claimed when the first tap is accepted, not when the edit lands.
describe('an answer is recorded once even when the acknowledgement cannot be edited in', () => {
  const MESSAGE_TOO_LONG = () => Promise.reject(new Error('Bad Request: MESSAGE_TOO_LONG'));
  const NETWORK_DOWN = () => Promise.reject(new Error('network down'));
  const LONG_QUESTION = 'К'.repeat(4090);

  test('a 3000-character option under a near-limit question is delivered, acknowledged without the question, reaches the AI whole and once', async () => {
    const option = cyrillicOption(200).repeat(15);
    const keyboard = await ask([option, 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    const first = tap(dataOfButton(keyboard, 0), { text: LONG_QUESTION, keyboard });
    first.editText.mockImplementationOnce(MESSAGE_TOO_LONG);

    await handler(first.ctx);

    expect(first.editText).toHaveBeenLastCalledWith(`✅ ${option}`);
    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, option);

    // Telegram now shows the answer alone, which ends in "✅ answer".
    await handler(tap(dataOfButton(keyboard, 0), { text: `✅ ${option}` }).ctx);
    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['both edits are refused as too long', [MESSAGE_TOO_LONG, MESSAGE_TOO_LONG]],
    ['the edit fails for another reason', [NETWORK_DOWN]],
  ])('%s: the message still shows the old question and keyboard, a second tap is ignored', async (_case, failures) => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    const messageId = nextMessageId();
    const first = tap(dataOfButton(keyboard, 0), { text: LONG_QUESTION, keyboard, messageId });
    for (const failure of failures) first.editText.mockImplementationOnce(failure);

    await handler(first.ctx);
    // The client still shows the unanswered message and its buttons.
    const second = tap(dataOfButton(keyboard, 1), { text: LONG_QUESTION, keyboard, messageId });
    await handler(second.ctx);

    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, cyrillicOption(60));
    expect(second.editText).not.toHaveBeenCalled();
    expect(second.answer).toHaveBeenCalledWith();
  });

  test('two taps in flight at once reach the AI once', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    const messageId = nextMessageId();
    const first = tap(dataOfButton(keyboard, 0), { keyboard, messageId });
    const second = tap(dataOfButton(keyboard, 1), { keyboard, messageId });

    await Promise.all([handler(first.ctx), handler(second.ctx)]);

    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
  });

  test('an answer too long for any message is acknowledged in a shortened form that still reads as answered', async () => {
    const label = 'Я'.repeat(5000);
    const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [[{ text: label, callback_data: 'ai_opt:0' }]] };
    const { onAiButtonClick, handler } = setup();
    const { ctx, editText } = tap('ai_opt:0', { keyboard });

    await handler(ctx);

    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, label);
    const acknowledgement = String(editText.mock.calls.at(-1)?.[0]);
    expect(acknowledgement.length).toBeLessThanOrEqual(4096);
    expect(acknowledgement).toBe(`${QUESTION}\n\n✅ ${'Я'.repeat(4000)}…`);
  });

  test('an answer with line breaks is acknowledged on one line so the answered check recognises it', async () => {
    const label = 'Создать\nу меня\r\nи пригласить';
    const keyboard: TelegramInlineKeyboardMarkup = { inline_keyboard: [[{ text: label, callback_data: 'ai_opt:0' }]] };
    const { onAiButtonClick, handler } = setup();
    const first = tap('ai_opt:0', { keyboard });

    await handler(first.ctx);

    const [acknowledged] = first.editText.mock.calls.at(-1) as [string];
    expect(acknowledged).toBe(`${QUESTION}\n\n✅ Создать у меня и пригласить`);
    await handler(tap('ai_opt:0', { text: acknowledged }).ctx);
    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, label);
  });
});

// Production builds the callback handler anew for every update (src/bot/index.ts), so the memory of
// an answered message cannot live in the handler: each tap here gets a handler of its own.
describe('an answer is recorded once across handlers built per update', () => {
  test('a failed acknowledgement edit, then a second tap on a fresh handler, reach the AI once', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const onAiButtonClick = mock<ButtonClick>(() => Promise.resolve());
    const messageId = nextMessageId();
    const first = tap(dataOfButton(keyboard, 0), { keyboard, messageId });
    first.editText.mockImplementationOnce(() => Promise.reject(new Error('network down')));

    await makeCallbackHandler({ onAiButtonClick })(first.ctx);
    // The client still shows the unanswered message and its buttons.
    const second = tap(dataOfButton(keyboard, 1), { keyboard, messageId });
    await makeCallbackHandler({ onAiButtonClick })(second.ctx);

    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
    expect(second.editText).not.toHaveBeenCalled();
    expect(second.answer).toHaveBeenCalledWith();
  });

  test('the same message id in another chat is a different question', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const onAiButtonClick = mock<ButtonClick>(() => Promise.resolve());
    const messageId = nextMessageId();

    await makeCallbackHandler({ onAiButtonClick })(tap(dataOfButton(keyboard, 0), { keyboard, messageId }).ctx);
    await makeCallbackHandler({ onAiButtonClick })(
      tap(dataOfButton(keyboard, 0), { keyboard, messageId, by: OTHER_MEMBER }).ctx,
    );

    expect(onAiButtonClick).toHaveBeenCalledTimes(2);
  });
});

// The claim keeps a second tap away from the AI, so it must not outlive a tap that never got the
// answer to the AI: otherwise the user's retap is ignored and the answer is lost until a restart.
describe('a tap that fails before the AI continuation does not swallow the retap', () => {
  test('a callback query that can no longer be answered still records the answer and runs the AI once', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const { onAiButtonClick, handler } = setup();
    const first = tap(dataOfButton(keyboard, 0), { keyboard });
    first.answer.mockImplementationOnce(() => Promise.reject(new Error('query is too old')));

    await handler(first.ctx);

    expect(first.editText).toHaveBeenCalledTimes(1);
    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
    expect(onAiButtonClick).toHaveBeenCalledWith(ASKER, ASKER, cyrillicOption(60));
  });

  test('a failure before the continuation starts releases the claim, so the retap is processed', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const onAiButtonClick = mock<ButtonClick>(() => Promise.resolve());
    onAiButtonClick.mockImplementationOnce(() => {
      throw new Error('agent factory failed');
    });
    const handler = makeCallbackHandler({ onAiButtonClick });
    const messageId = nextMessageId();

    // The dispatcher answers a handler failure itself, so the handler's own rejection is not visible here.
    await handler(tap(dataOfButton(keyboard, 0), { keyboard, messageId }).ctx);
    await handler(tap(dataOfButton(keyboard, 0), { keyboard, messageId }).ctx);

    expect(onAiButtonClick).toHaveBeenCalledTimes(2);
  });

  test('a continuation that started and then failed keeps the claim: the AI is not run twice', async () => {
    const keyboard = await ask([cyrillicOption(60), 'Нет'], false);
    const onAiButtonClick = mock<ButtonClick>(() => Promise.reject(new Error('provider down')));
    const handler = makeCallbackHandler({ onAiButtonClick });
    const messageId = nextMessageId();

    await handler(tap(dataOfButton(keyboard, 0), { keyboard, messageId }).ctx);
    await handler(tap(dataOfButton(keyboard, 0), { keyboard, messageId }).ctx);

    expect(onAiButtonClick).toHaveBeenCalledTimes(1);
  });
});
