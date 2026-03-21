import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFetch(filePath = 'voice/file.ogg') {
  return mock(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: filePath } }));
    }
    return new Response(Buffer.from('fake-audio'));
  }) as unknown as typeof fetch;
}

function makeVoiceDeps(overrides: Record<string, unknown> = {}) {
  return {
    agent: { run: mock(() => Promise.resolve({ responseText: 'Ответ от AI', toolCalls: [], toolResults: [] })) },
    eventService: {},
    holidayService: {},
    chatHistory: {},
    conversationLogger: { logUserMessage: mock(() => {}) },
    userRepo: { update: mock(() => {}) },
    reminderRepo: {},
    sceneStorage: { get: mock(() => Promise.resolve(null)) },
    botUsername: 'TestBot',
    transcriptionService: { transcribe: mock(() => Promise.resolve('создай встречу на завтра')) },
    botToken: 'test-token',
    ...overrides,
  };
}

function makeVoiceCtx(userOverrides: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
  return {
    dbUser: {
      telegram_id: 100,
      language: 'ru',
      timezone: 'UTC',
      voice_response_enabled: null,
      ...userOverrides,
    },
    voice: { file_id: 'voice_123', duration: 5 },
    chatId: 100,
    chat: { type: 'private' },
    send: mock(() => Promise.resolve()),
    ...ctxOverrides,
  };
}

function makeCallbackCtx(data: string, userOverrides: Record<string, unknown> = {}) {
  return {
    data,
    chatId: 100,
    dbUser: {
      telegram_id: 100,
      language: 'ru',
      timezone: 'UTC',
      voice_response_enabled: null,
      ...userOverrides,
    },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    message: { chat: { id: 100 }, send: mock(() => Promise.resolve()) },
    chat: { id: 100 },
  };
}

function makeCallbackHandler(userRepo: { update: ReturnType<typeof mock> }) {
  return createCallbackHandler(
    {} as never, // eventService
    {} as never, // editValueScene
    {} as never, // holidayService
    {} as never, // prefsService
    undefined, // calendarRepo
    undefined, // disconnectDeps
    undefined, // onCalendarsDone
    undefined, // renderService
    undefined, // invitationService
    undefined, // eventRepo
    undefined, // chatHistoryRepo
    undefined, // onAiButtonClick
    undefined, // oauthDeps
    undefined, // invitationNotifyDeps
    undefined, // onboardingScene
    undefined, // editProposalDeps
    undefined, // callSettingsRepo
    undefined, // sharingSettingsRepo
    undefined, // feedbackDeps
    userRepo as never,
  );
}

function makeCallbackHandlerWithVoice(deps: {
  userRepo: { update: ReturnType<typeof mock> };
  chatHistoryRepo: { getRecent: ReturnType<typeof mock>; save: ReturnType<typeof mock> };
  voiceDeps: {
    kokoroTts?: { synthesize: ReturnType<typeof mock> };
    sendVoice: ReturnType<typeof mock>;
  };
}) {
  return createCallbackHandler(
    {} as never, // eventService
    {} as never, // editValueScene
    {} as never, // holidayService
    {} as never, // prefsService
    undefined, // calendarRepo
    undefined, // disconnectDeps
    undefined, // onCalendarsDone
    undefined, // renderService
    undefined, // invitationService
    undefined, // eventRepo
    deps.chatHistoryRepo as never, // chatHistoryRepo
    undefined, // onAiButtonClick
    undefined, // oauthDeps
    undefined, // invitationNotifyDeps
    undefined, // onboardingScene
    undefined, // editProposalDeps
    undefined, // callSettingsRepo
    undefined, // sharingSettingsRepo
    undefined, // feedbackDeps
    deps.userRepo as never, // userRepo
    undefined, // intentDeps
    undefined, // secretaryDeps
    undefined, // proposalDeps
    undefined, // snoozeDeps
    undefined, // forceInviteDeps
    undefined, // proposeTimeSessions
    undefined, // invitationRepo
    deps.voiceDeps as never, // voiceDeps
  );
}

// ── Tests: voice response prompt ──────────────────────────────────────────────

describe('voice response prompt', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  test('shows prompt after first voice when voice_response_enabled is null', async () => {
    const deps = makeVoiceDeps();
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: null });
      await handler(ctx as never);

      // AI was called
      expect(deps.agent.run).toHaveBeenCalledTimes(1);

      // send was called for the prompt
      expect(ctx.send).toHaveBeenCalledTimes(1);
      const [text, options] = (ctx.send as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
        string,
        { reply_markup: unknown },
      ];
      expect(text).toContain('голосовые ответы');
      expect(options?.reply_markup).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does NOT show prompt when voice_response_enabled is 0', async () => {
    const deps = makeVoiceDeps();
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: 0 });
      await handler(ctx as never);

      expect(ctx.send).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('does NOT show prompt when voice_response_enabled is 1', async () => {
    const deps = makeVoiceDeps();
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: 1 });
      await handler(ctx as never);

      expect(ctx.send).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TTS does NOT fire when voice_response_enabled is null', async () => {
    const synthesize = mock(() => Promise.resolve(Buffer.from('audio')));
    const sendVoice = mock(() => Promise.resolve());
    const deps = makeVoiceDeps({
      sileroTts: { synthesize },
      sendVoice,
      stressDictionary: { lookup: () => null },
    });
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: null });
      await handler(ctx as never);

      expect(synthesize).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TTS does NOT fire when voice_response_enabled is 0', async () => {
    const synthesize = mock(() => Promise.resolve(Buffer.from('audio')));
    const sendVoice = mock(() => Promise.resolve());
    const deps = makeVoiceDeps({
      sileroTts: { synthesize },
      sendVoice,
      stressDictionary: { lookup: () => null },
    });
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: 0 });
      await handler(ctx as never);

      expect(synthesize).not.toHaveBeenCalled();
      expect(sendVoice).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('TTS fires when voice_response_enabled is 1', async () => {
    const synthesize = mock(() => Promise.resolve(Buffer.from('audio')));
    const sendVoice = mock(() => Promise.resolve());
    const deps = makeVoiceDeps({
      sileroTts: { synthesize },
      sendVoice,
      stressDictionary: { lookup: () => null },
    });
    globalThis.fetch = makeFetch();

    try {
      const handler = createMessageHandler(deps as never);
      const ctx = makeVoiceCtx({ voice_response_enabled: 1 });
      await handler(ctx as never);

      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(sendVoice).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Tests: voice_prompt callbacks ─────────────────────────────────────────────

describe('voice_prompt callback', () => {
  test('voice_prompt:yes sets voice_response_enabled to 1', async () => {
    const userRepo = { update: mock(() => {}) };
    const handler = makeCallbackHandler(userRepo);
    const ctx = makeCallbackCtx('voice_prompt:yes');
    await handler(ctx as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { voice_response_enabled: 1 });
    const editArg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editArg).toContain('включены');
    expect(ctx.answer).toHaveBeenCalledTimes(1);
  });

  test('voice_prompt:no sets voice_response_enabled to 0', async () => {
    const userRepo = { update: mock(() => {}) };
    const handler = makeCallbackHandler(userRepo);
    const ctx = makeCallbackCtx('voice_prompt:no');
    await handler(ctx as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { voice_response_enabled: 0 });
    const editArg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editArg).toContain('текстом');
    expect(ctx.answer).toHaveBeenCalledTimes(1);
  });

  test('voice_prompt:yes with voiceDeps sends TTS then shows enabled', async () => {
    const userRepo = { update: mock(() => {}) };
    const chatHistoryRepo = {
      save: mock(() => {}),
      getRecent: mock(() => [
        { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'Your meeting is set' }]) },
      ]),
    };
    const synthesize = mock(() => Promise.resolve(Buffer.from('audio')));
    const sendVoice = mock(() => Promise.resolve());
    const voiceDeps = { kokoroTts: { synthesize }, sendVoice };

    const handler = makeCallbackHandlerWithVoice({ userRepo, chatHistoryRepo, voiceDeps });
    const ctx = makeCallbackCtx('voice_prompt:yes', { language: 'en' });
    await handler(ctx as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { voice_response_enabled: 1 });
    const editCalls = ctx.editText.mock.calls;
    expect((editCalls[0] as unknown[])[0]).toBe('⌛');
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect((editCalls[editCalls.length - 1] as unknown[])[0]).toBe('🎤 Voice responses enabled!');
    expect(ctx.answer).toHaveBeenCalledTimes(1);
  });

  test('voice_prompt:yes shows demo_failed message when TTS throws', async () => {
    const userRepo = { update: mock(() => {}) };
    const chatHistoryRepo = {
      save: mock(() => {}),
      getRecent: mock(() => [
        { role: 'assistant', content: JSON.stringify([{ type: 'text', text: 'Your meeting is set' }]) },
      ]),
    };
    const synthesize = mock(() => Promise.reject(new Error('TTS unavailable')));
    const sendVoice = mock(() => Promise.resolve());
    const voiceDeps = { kokoroTts: { synthesize }, sendVoice };

    const handler = makeCallbackHandlerWithVoice({ userRepo, chatHistoryRepo, voiceDeps });
    const ctx = makeCallbackCtx('voice_prompt:yes', { language: 'en' });
    await handler(ctx as never);

    expect(userRepo.update).toHaveBeenCalledWith(100, { voice_response_enabled: 1 });
    expect(sendVoice).not.toHaveBeenCalled();
    const editCalls = ctx.editText.mock.calls;
    const lastEdit = (editCalls[editCalls.length - 1] as unknown[])[0] as string;
    expect(lastEdit).toContain('Demo playback failed');
  });

  test('voice_prompt without userRepo does nothing gracefully', async () => {
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never);
    const ctx = makeCallbackCtx('voice_prompt:yes');
    await handler(ctx as never);
    // No userRepo — falls through to unknown action
    expect(ctx.answer).toHaveBeenCalled();
  });
});
