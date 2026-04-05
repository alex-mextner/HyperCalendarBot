import { describe, expect, mock, test } from 'bun:test';
import {
  buildAgentContextFactory,
  createMessageHandler,
  stripJsonFences,
  toEventSummary,
} from '../../../src/bot/handlers/message.handler.ts';

function makeDeps(overrides: { [key: string]: unknown } = {}) {
  return {
    agent: { run: mock(() => Promise.resolve()) },
    eventService: { getEventsInRange: mock(() => []) },
    holidayService: {},
    chatHistory: {},
    conversationLogger: { logUserMessage: mock(() => {}), logBotResponse: mock(() => {}) },
    userRepo: {},
    eventReminderRepo: {},
    sceneStorage: { get: mock(() => Promise.resolve(null)) },
    botUsername: 'TestBot',
    ...overrides,
  };
}

interface MockCtxOverrides {
  dbUser?: Partial<import('../../../src/database/types.ts').User> | undefined;
  text?: string | undefined;
  chatId?: number;
  chat?: { type: string; title?: string };
  from?: { firstName?: string; username?: string; id?: number; first_name?: string };
  send?: ReturnType<typeof mock>;
  voice?: { file_id: string; duration: number };
  scene?: { enter: ReturnType<typeof mock> };
  replyMessage?: { from: { id: number } };
}

function makeCtx(overrides: MockCtxOverrides = {}) {
  return {
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    text: 'привет',
    chatId: 100,
    chat: { type: 'private' },
    from: { firstName: 'Alex', username: 'alex' },
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

  describe('Trigger 2: callback-only step auto-pause', () => {
    const callbackOnlyScene = JSON.stringify({ name: 'add_event', step: 3, state: { title: 'Test' } });

    test('routes to AI and saves pause when user types on a callback-only step', async () => {
      const saveScene = mock(() => Promise.resolve());
      const deps = makeDeps({
        sceneStorage: { get: mock(() => Promise.resolve(callbackOnlyScene)) },
        scenePauseService: {
          get: mock(() => Promise.resolve(null)),
          save: saveScene,
        },
      });
      const handler = createMessageHandler(deps as never);
      await handler(makeCtx({ text: 'каждую неделю' }) as never);

      expect(saveScene).toHaveBeenCalledWith(100, {
        sceneName: 'add_event',
        step: 3,
        sceneState: { title: 'Test' },
      });
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('does not auto-pause for non-callback-only steps (step 1)', async () => {
      const saveScene = mock(() => Promise.resolve());
      const deps = makeDeps({
        sceneStorage: {
          get: mock(() => Promise.resolve(JSON.stringify({ name: 'add_event', step: 1, state: {} }))),
        },
        scenePauseService: {
          get: mock(() => Promise.resolve(null)),
          save: saveScene,
        },
      });
      const handler = createMessageHandler(deps as never);
      await handler(makeCtx() as never);

      expect(saveScene).not.toHaveBeenCalled();
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('falls through to AI when scene is already manually paused', async () => {
      const deps = makeDeps({
        sceneStorage: { get: mock(() => Promise.resolve(callbackOnlyScene)) },
        scenePauseService: {
          get: mock(() => Promise.resolve({ sceneName: 'add_event', step: 3, sceneState: {} })),
          save: mock(() => Promise.resolve()),
        },
      });
      const handler = createMessageHandler(deps as never);
      await handler(makeCtx() as never);

      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });
  });

  describe('mandatory onboarding gate', () => {
    test('redirects to onboarding when user has not completed it', async () => {
      const onboardingScene = { name: 'onboarding' };
      const sceneEnter = mock(() => Promise.resolve());
      const deps = makeDeps({ onboardingScene });
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 0 },
        scene: { enter: sceneEnter },
      });
      await handler(ctx as never);
      expect(sceneEnter).toHaveBeenCalledWith(onboardingScene);
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('does not redirect when onboarding is completed', async () => {
      const onboardingScene = { name: 'onboarding' };
      const deps = makeDeps({ onboardingScene });
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 },
      });
      await handler(ctx as never);
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('does not redirect in group chats', async () => {
      const onboardingScene = { name: 'onboarding' };
      const deps = makeDeps({ onboardingScene });
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 0 },
        text: 'встреча завтра',
        chat: { type: 'group', title: 'Work' },
      });
      await handler(ctx as never);
      // Group messages with keywords still go through (no redirect)
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('does not redirect if scene already active (onboarding in progress)', async () => {
      const onboardingScene = { name: 'onboarding' };
      const sceneEnter = mock(() => Promise.resolve());
      const deps = makeDeps({
        onboardingScene,
        sceneStorage: { get: mock(() => Promise.resolve(JSON.stringify({ name: 'onboarding', step: 1 }))) },
      });
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 0 },
        scene: { enter: sceneEnter },
      });
      await handler(ctx as never);
      expect(sceneEnter).not.toHaveBeenCalled();
    });

    test('redirects voice messages to onboarding too', async () => {
      const onboardingScene = { name: 'onboarding' };
      const sceneEnter = mock(() => Promise.resolve());
      const deps = makeDeps({
        onboardingScene,
        transcriptionService: { transcribe: mock(() => Promise.resolve('привет')) },
        botToken: 'test-token',
      });
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 0 },
        text: undefined,
        voice: { file_id: 'voice_123', duration: 5 },
        scene: { enter: sceneEnter },
      });
      await handler(ctx as never);
      expect(sceneEnter).toHaveBeenCalledWith(onboardingScene);
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });
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
          from: { firstName: 'Alex' },
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

    test('routes group message starting with "Календарь,"', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'Календарь, что завтра?',
          chat: { type: 'group', title: 'Chat' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('routes group message starting with typo "Каледарь,"', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'Каледарь, добавь встречу',
          chat: { type: 'group', title: 'Chat' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('routes group message starting with "Calendar,"', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'Calendar, show tomorrow',
          chat: { type: 'group', title: 'Chat' },
        }) as never,
      );
      expect(deps.agent.run).toHaveBeenCalledTimes(1);
    });

    test('does NOT route group message starting with short irrelevant word', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      await handler(
        makeCtx({
          text: 'кал хватит спорить',
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
          replyMessage: { from: { id: 500 } },
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
          replyMessage: { from: { id: 999 } },
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
    function makeVoiceDeps(overrides: { [key: string]: unknown } = {}) {
      return makeDeps({
        transcriptionService: { transcribe: mock(() => Promise.resolve('создай встречу на завтра')) },
        botToken: 'test-token',
        ...overrides,
      });
    }

    function makeVoiceCtx(overrides: MockCtxOverrides = {}) {
      return makeCtx({
        text: undefined,
        voice: { file_id: 'voice_123', duration: 5 },
        ...overrides,
      });
    }

    test('transcribes voice and routes to AI agent with inputMode voice_message', async () => {
      const deps = makeVoiceDeps();
      // Mock fetch for Telegram file download
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as unknown as typeof fetch;

      try {
        const handler = createMessageHandler(deps as never);
        await handler(makeVoiceCtx() as never);
        expect(deps.agent.run).toHaveBeenCalledTimes(1);
        const call = (deps.agent.run as ReturnType<typeof mock>).mock.calls[0]![0] as {
          messageText: string;
          inputMode: string;
        };
        expect(call.messageText).toBe('создай встречу на завтра');
        expect(call.inputMode).toBe('voice_message');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('logs transcribed voice text before calling agent', async () => {
      const deps = makeVoiceDeps();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as unknown as typeof fetch;

      try {
        const handler = createMessageHandler(deps as never);
        await handler(makeVoiceCtx() as never);
        const logger = deps.conversationLogger as { logUserMessage: ReturnType<typeof mock> };
        expect(logger.logUserMessage).toHaveBeenCalledWith(100, 'создай встречу на завтра', undefined);
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
      }) as unknown as typeof fetch;

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

    test('saves error log and sends document to admin when voice processing fails', async () => {
      const deps = makeVoiceDeps({
        transcriptionService: { transcribe: mock(() => Promise.reject(new Error('Whisper API 503'))) },
        botAdminId: 999,
        botToken: 'test-bot-token',
      });
      const originalFetch = globalThis.fetch;
      const fetchCalls: { url: string; body: FormData }[] = [];
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        if (urlStr.includes('/sendDocument')) {
          fetchCalls.push({ url: urlStr, body: init?.body as FormData });
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as unknown as typeof fetch;

      try {
        const ctx = makeVoiceCtx();
        const handler = createMessageHandler(deps as never);
        await handler(ctx as never);
        // Wait for fire-and-forget admin notification (mkdir + file write + fetch)
        await Bun.sleep(50);

        expect(fetchCalls).toHaveLength(1);
        const { url, body } = fetchCalls[0]!;
        expect(url).toContain('test-bot-token/sendDocument');
        expect(body.get('chat_id')).toBe('999');

        const doc = body.get('document') as File;
        expect(doc.name).toContain('voice-error-');
        const text = await doc.text();
        expect(text).toContain('Whisper API 503');
        expect(text).toContain('Duration: 5s');

        // Verify log file was written
        const { readdir } = await import('node:fs/promises');
        const files = await readdir('logs/voice-errors');
        expect(files.some((f) => f.startsWith('voice-error-100-'))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
        // Cleanup log files
        const { rm } = await import('node:fs/promises');
        await rm('logs/voice-errors', { recursive: true, force: true });
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
      }) as unknown as typeof fetch;

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

  describe('location message → timezone confirmation', () => {
    test('sends confirmation prompt with buttons when timezone differs', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        text: undefined,
        dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC', onboarding_completed: 1 },
      });
      (ctx as { location?: { latitude: number; longitude: number } }).location = {
        latitude: 55.7558,
        longitude: 37.6173,
      };
      await handler(ctx as never);

      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Europe/Moscow');
      expect(msg).toContain('UTC');
      expect(msg).toContain('Обновить часовой пояс?');
      const opts = (ctx.send.mock.calls[0] as unknown[])[1] as { parse_mode: string; reply_markup: unknown };
      expect(opts.parse_mode).toBe('HTML');
      expect(opts.reply_markup).toBeDefined();
    });

    test('sends same-timezone message when location matches current timezone', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        text: undefined,
        dbUser: { telegram_id: 100, language: 'ru', timezone: 'Europe/Moscow', onboarding_completed: 1 },
      });
      (ctx as { location?: { latitude: number; longitude: number } }).location = {
        latitude: 55.7558,
        longitude: 37.6173,
      };
      await handler(ctx as never);

      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Europe/Moscow');
      expect(msg).toContain('уже');
    });

    test('does not route to AI agent after handling location', async () => {
      const deps = makeDeps();
      const handler = createMessageHandler(deps as never);
      const ctx = makeCtx({
        text: undefined,
        dbUser: { telegram_id: 100, language: 'en', timezone: 'UTC', onboarding_completed: 1 },
      });
      (ctx as { location?: { latitude: number; longitude: number } }).location = {
        latitude: 40.7128,
        longitude: -74.006,
      };
      await handler(ctx as never);

      expect(deps.agent.run).toHaveBeenCalledTimes(0);
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('Update timezone?');
    });
  });
});

describe('toEventSummary', () => {
  const BASE_EVENT = {
    id: 1,
    user_id: 100,
    title: 'Team standup',
    description: null,
    category: null,
    start_at: '2026-03-20T07:00:00Z', // 10:00 MSK (UTC+3)
    end_at: '2026-03-20T07:30:00Z',
    all_day: 0,
    timezone: 'Europe/Moscow',
    location: null,
    recurrence_rule: null,
    recurrence_end_at: null,
    parent_event_id: null,
    original_start_at: null,
    is_cancelled: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only' as const,
    sync_version: 0,
    owner_type: 'user' as const,
    group_id: null,
    created_by: null,
    last_synced_at: null,
    created_at: '2026-03-19T10:00:00Z',
    updated_at: '2026-03-19T10:00:00Z',
  };

  test('sets date and time in user timezone for timed event', () => {
    const summary = toEventSummary(BASE_EVENT, 'Europe/Moscow');
    expect(summary.id).toBe(1);
    expect(summary.title).toBe('Team standup');
    expect(summary.date).toBe('2026-03-20');
    expect(summary.time).toBe('10:00');
    expect(summary.all_day).toBe(false);
  });

  test('omits time for all-day event', () => {
    const event = { ...BASE_EVENT, all_day: 1 };
    const summary = toEventSummary(event, 'UTC');
    expect(summary.time).toBeUndefined();
    expect(summary.all_day).toBe(true);
  });

  test('includes end_at when present', () => {
    const summary = toEventSummary(BASE_EVENT, 'UTC');
    expect(summary.end_at).toBe('2026-03-20T07:30:00Z');
  });

  test('omits end_at when null', () => {
    const event = { ...BASE_EVENT, end_at: null };
    const summary = toEventSummary(event, 'UTC');
    expect(summary.end_at).toBeUndefined();
  });

  test('includes optional fields when present', () => {
    const event = {
      ...BASE_EVENT,
      description: 'Daily sync',
      location: 'Room 3',
      recurrence_rule: 'FREQ=DAILY',
    };
    const summary = toEventSummary(event, 'UTC');
    expect(summary.description).toBe('Daily sync');
    expect(summary.location).toBe('Room 3');
    expect(summary.recurrence_rule).toBe('FREQ=DAILY');
  });

  test('omits optional fields when null', () => {
    const summary = toEventSummary(BASE_EVENT, 'UTC');
    expect(summary.description).toBeUndefined();
    expect(summary.location).toBeUndefined();
    expect(summary.recurrence_rule).toBeUndefined();
  });
});

describe('voice reply TTS fallback', () => {
  const audioBuffer = Buffer.from('fake-audio');
  const fakeAudioDownload = mock(() => Promise.resolve(Buffer.from('fake-voice-download')));

  function makeVoiceDeps(overrides: { [key: string]: unknown } = {}) {
    return makeDeps({
      agent: { run: mock(() => Promise.resolve({ responseText: 'Ответ бота' })) },
      sendVoice: mock(() => Promise.resolve()),
      botToken: 'test-token',
      transcriptionService: { transcribe: mock(() => Promise.resolve('Пользователь говорит')) },
      downloadVoiceBuffer: fakeAudioDownload,
      ...overrides,
    });
  }

  function makeVoiceCtx(overrides: MockCtxOverrides = {}) {
    return makeCtx({
      dbUser: { telegram_id: 1, language: 'ru', timezone: 'UTC', voice_response_enabled: 1 },
      voice: { file_id: 'test-file-id', duration: 5 },
      text: undefined,
      ...overrides,
    });
  }

  test('uses primary sileroTts when available', async () => {
    const sileroTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const stressDictionary = { lookup: () => undefined } as never;
    const deps = makeVoiceDeps({ sileroTts, fallbackTts, stressDictionary });
    const handler = createMessageHandler(deps as never);
    await handler(makeVoiceCtx() as never);
    expect(sileroTts.synthesize).toHaveBeenCalledTimes(1);
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(0);
    expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1);
  });

  test('falls back to fallbackTts when primary sileroTts throws', async () => {
    const sileroTts = { synthesize: mock(() => Promise.reject(new Error('silero down'))) };
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const stressDictionary = { lookup: () => undefined } as never;
    const deps = makeVoiceDeps({ sileroTts, fallbackTts, stressDictionary });
    const handler = createMessageHandler(deps as never);
    await handler(makeVoiceCtx() as never);
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
    expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1);
  });

  test('uses fallbackTts when no primary TTS configured', async () => {
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ fallbackTts });
    const handler = createMessageHandler(deps as never);
    await handler(makeVoiceCtx() as never);
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
    expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1);
  });

  test('sends no voice when no TTS configured at all', async () => {
    const sendVoice = mock(() => Promise.resolve());
    const deps = makeVoiceDeps({ sendVoice });
    const handler = createMessageHandler(deps as never);
    await handler(makeVoiceCtx() as never);
    expect(sendVoice).toHaveBeenCalledTimes(0);
  });

  test('uses fallbackTts for EN when kokoroTts throws', async () => {
    const kokoroTts = { synthesize: mock(() => Promise.reject(new Error('kokoro down'))) };
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ kokoroTts, fallbackTts });
    const handler = createMessageHandler(deps as never);
    await handler(
      makeVoiceCtx({ dbUser: { telegram_id: 1, language: 'en', timezone: 'UTC', voice_response_enabled: 1 } }) as never,
    );
    expect(fallbackTts.synthesize).toHaveBeenCalledWith(expect.any(String), 'en');
    expect((deps as never as { sendVoice: ReturnType<typeof mock> }).sendVoice).toHaveBeenCalledTimes(1);
  });
});

describe('intent supplement integration', () => {
  test('AI agent runs after successful intent match (supplement mode)', async () => {
    const agentRun = mock(() =>
      Promise.resolve({
        responseText: '',
        toolCalls: [{ name: 'supplement_skip', input: {} }],
        toolResults: [{ success: true }],
      }),
    );

    const intentMatcher = {
      match: mock(() => ({ intentId: 1, captures: {} })),
      load: mock(() => {}),
    };
    const intentRepo = {
      getById: mock(() => ({
        id: 1,
        workflow: JSON.stringify({ steps: [] }),
        format: 'text',
        canonical_name: 'test_intent',
        phrases: '[]',
        trigger_words: '[]',
        pattern: null,
      })),
    };
    const intentExecutor = {
      run: mock(() => Promise.resolve({ success: true, response: 'Вот твои события.' })),
    };
    const workflowSessions = {
      get: mock(() => null),
      set: mock(() => {}),
      delete: mock(() => {}),
      deleteByUser: mock(() => {}),
    };

    const deps = makeDeps({
      agent: {
        run: agentRun,
        getSender: mock(() => ({})),
      },
      eventService: {
        getEventsInRange: mock(() => []),
        getLatestCreated: mock(() => null),
        getEvent: mock(() => null),
      },
      chatHistory: {
        save: mock(() => {}),
      },
      intentMatcher,
      intentRepo,
      intentExecutor,
      workflowSessions,
    });

    const ctx = makeCtx({ text: 'покажи события' });
    await createMessageHandler(deps as never)(ctx as never);

    // auto-response was sent
    expect(ctx.send).toHaveBeenCalledWith('Вот твои события.');
    // AI supplement also ran
    expect(agentRun).toHaveBeenCalledTimes(1);
    // supplement_skip was called so no second ctx.send for supplement text
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });
});

describe('stripJsonFences', () => {
  test('passes through raw JSON untouched', () => {
    const json = '{"phrases":["привет"]}';
    expect(stripJsonFences(json)).toBe(json);
  });

  test('strips ```json fence', () => {
    const json = '{"phrases":["привет"]}';
    expect(stripJsonFences(`\`\`\`json\n${json}\n\`\`\``)).toBe(json);
  });

  test('strips plain ``` fence', () => {
    const json = '{"phrases":["привет"]}';
    expect(stripJsonFences(`\`\`\`\n${json}\n\`\`\``)).toBe(json);
  });

  test('strips fences case-insensitively', () => {
    const json = '{"phrases":["ok"]}';
    expect(stripJsonFences(`\`\`\`JSON\n${json}\n\`\`\``)).toBe(json);
  });

  test('trims surrounding whitespace', () => {
    const json = '{"phrases":["ok"]}';
    expect(stripJsonFences(`  ${json}  `)).toBe(json);
  });
});

describe('buildAgentContextFactory', () => {
  const user = { telegram_id: 1, language: 'ru', timezone: 'UTC' } as never;

  test('passes userMemoryRepo into AgentContext', () => {
    const userMemoryRepo = { getAll: mock(() => []), append: mock(() => {}), rewrite: mock(() => {}) };
    const birthdayService = {} as never;
    const deps = {
      ...makeDeps({ userMemoryRepo, birthdayService }),
      secretaryRepo: undefined,
    };
    const ctx = buildAgentContextFactory(deps as never)(user, 1, 'hi');
    expect(ctx.birthday?.userMemoryRepo).toBe(userMemoryRepo as never);
  });

  test('AgentContext.userMemoryRepo is undefined when not provided in deps', () => {
    const ctx = buildAgentContextFactory(makeDeps() as never)(user, 1, 'hi');
    expect(ctx.birthday?.userMemoryRepo).toBeUndefined();
  });
});
