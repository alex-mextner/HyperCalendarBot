import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    agent: { run: mock(() => Promise.resolve()) },
    eventService: {},
    holidayService: {},
    chatHistory: {},
    userRepo: {},
    reminderRepo: {},
    sceneStorage: { get: mock(() => Promise.resolve(null)) },
    botUsername: 'TestBot',
    ...overrides,
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    text: 'привет',
    chatId: 100,
    chat: { type: 'private' },
    from: { first_name: 'Alex', username: 'alex' },
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe('createMessageHandler', () => {
  test('routes text message to AI agent in private chat', async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps as never);
    await handler(makeCtx() as never);
    expect(deps.agent.run).toHaveBeenCalledTimes(1);
  });

  test('ignores messages without text', async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps as never);
    await handler(makeCtx({ text: undefined }) as never);
    expect(deps.agent.run).toHaveBeenCalledTimes(0);
  });

  test('ignores commands starting with /', async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps as never);
    await handler(makeCtx({ text: '/help' }) as never);
    expect(deps.agent.run).toHaveBeenCalledTimes(0);
  });

  test('ignores messages when scene is active', async () => {
    const deps = makeDeps({
      sceneStorage: { get: mock(() => Promise.resolve({ step: 0 })) },
    });
    const handler = createMessageHandler(deps as never);
    await handler(makeCtx() as never);
    expect(deps.agent.run).toHaveBeenCalledTimes(0);
  });

  test('ignores messages without dbUser', async () => {
    const deps = makeDeps();
    const handler = createMessageHandler(deps as never);
    await handler(makeCtx({ dbUser: undefined }) as never);
    expect(deps.agent.run).toHaveBeenCalledTimes(0);
  });

  describe('group messages', () => {
    test('ignores irrelevant group messages', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'привет как дела',
          chat: { type: 'group', title: 'Friends' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('routes group message with calendar keyword', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'встреча завтра в 10',
          chat: { type: 'group', title: 'Work' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('routes group message with @mention', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: '@TestBot покажи расписание',
          chat: { type: 'group', title: 'Work' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('prepends group context to messageText', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'встреча в 15:00',
          chat: { type: 'supergroup', title: 'Team' },
          from: { first_name: 'Alex' },
        }) as never,
      );
      const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as { messageText: string };
      expect(call.messageText).toContain('[Group: Team');
      expect(call.messageText).toContain('Alex');
    });

    test('does NOT match "планшет" as calendar keyword', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'купил новый планшет',
          chat: { type: 'group', title: 'Chat' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('fixes isReplyToBot — only matches actual bot ID, not any reply', async () => {
      const deps = makeDeps({ botId: 999 });
      const handler = createMessageHandler(deps as never);
      // Reply to some random user (id=500) — should NOT activate
      await handler(
        makeCtx({
          text: 'ок буду',
          chat: { type: 'group', title: 'Chat' },
          replyToMessage: { from: { id: 500 } },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('routes reply to bot by matching botId', async () => {
      const deps = makeDeps({ botId: 999 });
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'ок буду',
          chat: { type: 'group', title: 'Chat' },
          replyToMessage: { from: { id: 999 } },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('tracks group member when groupMemberRepo is provided', async () => {
      const groupMemberRepo = { upsert: mock(() => {}) };
      const deps = makeDeps({ groupMemberRepo });
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'встреча завтра',
          chat: { type: 'group', title: 'Work' },
        }) as never,
      );
      expect(groupMemberRepo.upsert).toHaveBeenCalledWith(100, 100);
    });

    describe('group sessions', () => {
      function makeGroupSessions(active = false) {
        return {
          hasActiveSession: mock(() => active),
          tick: mock(() => {}),
          activate: mock(() => {}),
          refresh: mock(() => {}),
        };
      }

      test('routes irrelevant message when session is active', async () => {
        const groupSessions = makeGroupSessions(true);
        const deps = makeDeps({ groupSessions });
        const handler = createMessageHandler(deps as never);
        await handler(
          makeCtx({
            text: 'да конечно',
            chat: { type: 'group', title: 'Work' },
          }) as never,
        );
        expect(deps.agent.run).toHaveBeenCalledTimes(1);
        expect(groupSessions.tick).toHaveBeenCalledWith(100);
      });

      test('skips irrelevant message when no session', async () => {
        const groupSessions = makeGroupSessions(false);
        const deps = makeDeps({ groupSessions });
        const handler = createMessageHandler(deps as never);
        await handler(
          makeCtx({
            text: 'да конечно',
            chat: { type: 'group', title: 'Work' },
          }) as never,
        );
        expect(deps.agent.run).toHaveBeenCalledTimes(0);
        expect(groupSessions.tick).not.toHaveBeenCalled();
      });

      test('passes onBotResponse that activates session', async () => {
        const groupSessions = makeGroupSessions(false);
        const deps = makeDeps({ groupSessions });
        const handler = createMessageHandler(deps as never);
        await handler(
          makeCtx({
            text: 'встреча завтра',
            chat: { type: 'group', title: 'Work' },
          }) as never,
        );
        // Extract onBotResponse from the AgentContext passed to agent.run
        const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as {
          onBotResponse?: (messageId: number) => void;
        };
        expect(call.onBotResponse).toBeDefined();
        // Call it — should activate since hasActiveSession returns false
        call.onBotResponse!(42);
        expect(groupSessions.activate).toHaveBeenCalledWith(100, 100, 42);
      });

      test('onBotResponse refreshes existing session', async () => {
        const groupSessions = makeGroupSessions(true);
        const deps = makeDeps({ groupSessions });
        const handler = createMessageHandler(deps as never);
        await handler(
          makeCtx({
            text: 'встреча завтра',
            chat: { type: 'group', title: 'Work' },
          }) as never,
        );
        const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as {
          onBotResponse?: (messageId: number) => void;
        };
        call.onBotResponse!(55);
        expect(groupSessions.refresh).toHaveBeenCalledWith(100, 55);
      });

      test('onBotResponse is undefined in private chats', async () => {
        const groupSessions = makeGroupSessions(false);
        const deps = makeDeps({ groupSessions });
        const handler = createMessageHandler(deps as never);
        await handler(makeCtx() as never);
        const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as {
          onBotResponse?: (messageId: number) => void;
        };
        expect(call.onBotResponse).toBeUndefined();
      });
    });
  });

  describe('voice messages', () => {
    function makeVoiceDeps(overrides: Record<string, unknown> = {}) {
      return makeDeps({
        transcriptionService: { transcribe: mock(() => Promise.resolve('создай встречу на завтра')) },
        botToken: 'test-token',
        ...overrides,
      });
    }

    function makeVoiceCtx(overrides: Record<string, unknown> = {}) {
      return makeCtx({
        text: undefined,
        voice: { file_id: 'voice_123', duration: 5 },
        ...overrides,
      });
    }

    test('transcribes voice and routes to AI agent with isVoiceMessage flag', async () => {
      const deps = makeVoiceDeps();
      // Mock fetch for Telegram file download
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as typeof fetch;

      try {
        const handler = createMessageHandler(deps as never);
        await handler(makeVoiceCtx() as never);
        expect(deps.agent.run).toHaveBeenCalledTimes(1);
        const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as {
          messageText: string;
          isVoiceMessage: boolean;
        };
        expect(call.messageText).toBe('создай встречу на завтра');
        expect(call.isVoiceMessage).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('ignores voice when transcriptionService is not configured', async () => {
      const deps = makeDeps(); // no transcriptionService
      const handler = createMessageHandler(deps as never);
      await handler(makeVoiceCtx() as never);
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('sends error message when transcription fails', async () => {
      const deps = makeVoiceDeps({
        transcriptionService: { transcribe: mock(() => Promise.reject(new Error('API error'))) },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as typeof fetch;

      try {
        const ctx = makeVoiceCtx();
        const handler = createMessageHandler(deps as never);
        await handler(ctx as never);
        expect(ctx.send).toHaveBeenCalledTimes(1);
        const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
        expect(msg).toContain('голосовое');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('sends empty speech message when transcription returns empty', async () => {
      const deps = makeVoiceDeps({
        transcriptionService: { transcribe: mock(() => Promise.resolve('')) },
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as typeof fetch;

      try {
        const ctx = makeVoiceCtx();
        const handler = createMessageHandler(deps as never);
        await handler(ctx as never);
        expect(deps.agent.run).toHaveBeenCalledTimes(0);
        expect(ctx.send).toHaveBeenCalledTimes(1);
        const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
        expect(msg).toContain('распознать');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  test('sends error message on agent failure', async () => {
    const deps = makeDeps({
      agent: { run: mock(() => Promise.reject(new Error('boom'))) },
    });
    const ctx = makeCtx();
    const handler = createMessageHandler(deps as never);
    await handler(ctx as never);
    expect(ctx.send).toHaveBeenCalledTimes(1);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('пошло не так');
  });
});
