import { describe, expect, mock, test } from 'bun:test';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';
import { type MockCtxOverrides, makeCtx, makeDeps } from './message-handler-fixtures.ts';

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

  describe('scene pause routing', () => {
    const recurrenceScene = JSON.stringify({ name: 'add_event', step: 3, state: { title: 'Test' } });

    test('keeps typed recurrence input inside the active /add scene', async () => {
      const saveScene = mock(() => Promise.resolve());
      const deps = makeDeps({
        sceneStorage: { get: mock(() => Promise.resolve(recurrenceScene)) },
        scenePauseService: { get: mock(() => Promise.resolve(null)), save: saveScene },
      });
      const handler = createMessageHandler(deps as never);
      await handler(makeCtx({ text: 'каждую неделю' }) as never);
      expect(saveScene).not.toHaveBeenCalled();
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('keeps ordinary add-event text inside the active scene', async () => {
      const saveScene = mock(() => Promise.resolve());
      const deps = makeDeps({
        sceneStorage: { get: mock(() => Promise.resolve(JSON.stringify({ name: 'add_event', step: 1, state: {} }))) },
        scenePauseService: { get: mock(() => Promise.resolve(null)), save: saveScene },
      });
      const handler = createMessageHandler(deps as never);
      await handler(makeCtx() as never);
      expect(saveScene).not.toHaveBeenCalled();
      expect(deps.agent.run).toHaveBeenCalledTimes(0);
    });

    test('falls through to AI when scene is already explicitly paused', async () => {
      const deps = makeDeps({
        sceneStorage: { get: mock(() => Promise.resolve(recurrenceScene)) },
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
      const adminDocumentSent = Promise.withResolvers<void>();
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('/getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/file.ogg' } }));
        }
        if (urlStr.includes('/sendDocument')) {
          fetchCalls.push({ url: urlStr, body: init?.body as FormData });
          adminDocumentSent.resolve();
          return new Response(JSON.stringify({ ok: true }));
        }
        return new Response(Buffer.from('fake-audio'));
      }) as unknown as typeof fetch;

      try {
        const ctx = makeVoiceCtx();
        const handler = createMessageHandler(deps as never);
        await handler(ctx as never);
        // The admin notification is fire-and-forget: wait for its sendDocument request itself (the
        // log file is written before it). The explicit bound sits below the 5 s test timeout so a
        // missing notice fails here and `finally` still restores fetch for the following tests.
        let noticeTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          adminDocumentSent.promise,
          new Promise<never>((_, reject) => {
            noticeTimer = setTimeout(() => reject(new Error('admin voice-error notice was not sent')), 3_000);
          }),
        ]).finally(() => clearTimeout(noticeTimer));

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
});
