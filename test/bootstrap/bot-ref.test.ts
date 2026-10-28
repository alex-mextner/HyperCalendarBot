import { describe, expect, test } from 'bun:test';
import {
  createBotHandle,
  createBotRef,
  createBroadcastSender,
  patchBotRef,
  type TelegramSendApi,
} from '../../src/bootstrap/bot-ref.ts';

function fakeApi(sendResult: unknown = { message_id: 42 }) {
  const sent: unknown[] = [];
  const edited: unknown[] = [];
  const voices: Array<{ chat_id: number; voice: File }> = [];
  const api: TelegramSendApi = {
    sendMessage: async (params) => {
      sent.push(params);
      return sendResult;
    },
    editMessageText: async (params) => {
      edited.push(params);
      return true;
    },
    sendVoice: async (params) => {
      voices.push(params);
      return {};
    },
  };
  return { api, sent, edited, voices };
}

describe('createBotRef', () => {
  test('starts with inert placeholders that answer without a bot', async () => {
    const ref = createBotRef();
    expect(await ref.sendMessage(1, 'hi')).toEqual({ message_id: 0 });
    await ref.sendVoice(1, Buffer.from('a'));
    await ref.editMessage(1, 2, 'x');
  });
});

describe('patchBotRef', () => {
  test('keeps the ref identity and routes sends through the real API', async () => {
    const ref = createBotRef();
    const held = ref;
    const { api, sent } = fakeApi();
    patchBotRef(ref, api);

    const result = await held.sendMessage(5, 'hello', 'HTML');

    expect(result).toEqual({ message_id: 42 });
    expect(sent).toEqual([{ chat_id: 5, text: 'hello', parse_mode: 'HTML' }]);
  });

  test('omits parse_mode and reply_markup when they are not given', async () => {
    const ref = createBotRef();
    const { api, sent } = fakeApi();
    patchBotRef(ref, api);
    await ref.sendMessage(5, 'plain');
    expect(sent).toEqual([{ chat_id: 5, text: 'plain' }]);
  });

  test('throws when the API answers without a message_id', async () => {
    const ref = createBotRef();
    const { api } = fakeApi(true);
    patchBotRef(ref, api);
    await expect(ref.sendMessage(9, 'x')).rejects.toThrow('sendMessage returned no message_id for chat 9');
  });

  test('editMessage forwards the chat, message and text', async () => {
    const ref = createBotRef();
    const { api, edited } = fakeApi();
    patchBotRef(ref, api);
    await ref.editMessage(3, 4, 'new', 'Markdown');
    expect(edited).toEqual([{ chat_id: 3, message_id: 4, text: 'new', parse_mode: 'Markdown' }]);
  });

  test('sendVoice wraps the audio as an mp3 file', async () => {
    const ref = createBotRef();
    const { api, voices } = fakeApi();
    patchBotRef(ref, api);
    await ref.sendVoice(8, Buffer.from('audio'));
    expect(voices[0]?.chat_id).toBe(8);
    expect(voices[0]?.voice.name).toBe('message.mp3');
    expect(voices[0]?.voice.type).toBe('audio/mpeg');
  });
});

describe('createBroadcastSender', () => {
  test('sends into a forum topic when a thread id is given', async () => {
    const { api, sent } = fakeApi();
    const result = await createBroadcastSender(api).sendMessage(-100, 'news', 'HTML', 7);
    expect(result).toEqual({ message_id: 42 });
    expect(sent).toEqual([{ chat_id: -100, text: 'news', parse_mode: 'HTML', message_thread_id: 7 }]);
  });

  test('omits the thread when there is none', async () => {
    const { api, sent } = fakeApi();
    await createBroadcastSender(api).sendMessage(-100, 'news');
    expect(sent).toEqual([{ chat_id: -100, text: 'news' }]);
  });
});

describe('createBotHandle', () => {
  test('reading before set throws, like an uninitialised binding', () => {
    expect(() => createBotHandle<{ api: string }>().get()).toThrow('Bot accessed before createBot() returned');
  });

  test('returns the bot once set', () => {
    const handle = createBotHandle<{ api: string }>();
    const bot = { api: 'real' };
    handle.set(bot);
    expect(handle.get()).toBe(bot);
  });
});
