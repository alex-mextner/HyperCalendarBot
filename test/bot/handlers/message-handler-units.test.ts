import { describe, expect, mock, test } from 'bun:test';
import type { VoiceAttachment } from 'gramio';
import type { MessageHandlerDeps } from '../../../src/bot/handlers/message/types.ts';
import {
  buildAgentContextFactory,
  createMessageHandler,
  stripJsonFences,
  toEventSummary,
} from '../../../src/bot/handlers/message.handler.ts';
import type { UserMemoryRepository } from '../../../src/database/repositories/user-memory.repository.ts';
import type { Intent } from '../../../src/database/types.ts';
import type { KokoroTtsService } from '../../../src/services/voice/kokoro-tts-service.ts';
import type { SileroTtsService } from '../../../src/services/voice/silero-tts-service.ts';
import type { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow } from '../telegram-fixtures.ts';
import { makeHandlerDeps, makeMessageCtx } from './message-handler-fixtures.ts';

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
    is_deleted: 0,
    reminder_overrides: null,
    google_event_id: null,
    google_calendar_id: null,
    google_etag: null,
    sync_status: 'local_only' as const,
    sync_version: 0,
    owner_type: 'user' as const,
    group_id: null,
    created_by: null,
    resolved_address: null,
    latitude: null,
    longitude: null,
    google_maps_url: null,
    location_verified: 0,
    venue_name: null,
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
  const voiceUser = makeUserRow({ telegram_id: 1, language: 'ru', timezone: 'UTC', voice_response_enabled: 1 });
  const noStress = stub<StressDictionary>({ lookup: () => null });

  function makeVoiceDeps(overrides: Partial<MessageHandlerDeps> = {}) {
    return makeHandlerDeps({
      agent: stub({
        run: mock(() => Promise.resolve({ responseText: 'Ответ бота', toolCalls: [], toolResults: [] })),
      }),
      sendVoice: mock(() => Promise.resolve()),
      botToken: 'test-token',
      transcriptionService: stub({ transcribe: mock(() => Promise.resolve('Пользователь говорит')) }),
      downloadVoiceBuffer: fakeAudioDownload,
      ...overrides,
    });
  }

  function makeVoiceCtx(dbUser = voiceUser) {
    return makeMessageCtx({
      dbUser,
      voice: stub<VoiceAttachment>({ fileId: 'test-file-id', duration: 5 }),
      text: undefined,
    });
  }

  test('uses primary sileroTts when available', async () => {
    const synthesize = mock(() => Promise.resolve(audioBuffer));
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ sileroTts: stub({ synthesize }), fallbackTts, stressDictionary: noStress });
    const handler = createMessageHandler(deps);
    await handler(makeVoiceCtx());
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(0);
    expect(deps.sendVoice).toHaveBeenCalledTimes(1);
  });

  test('falls back to fallbackTts when primary sileroTts throws', async () => {
    const sileroTts = stub<SileroTtsService>({ synthesize: mock(() => Promise.reject(new Error('silero down'))) });
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ sileroTts, fallbackTts, stressDictionary: noStress });
    const handler = createMessageHandler(deps);
    await handler(makeVoiceCtx());
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.sendVoice).toHaveBeenCalledTimes(1);
  });

  test('uses fallbackTts when no primary TTS configured', async () => {
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ fallbackTts });
    const handler = createMessageHandler(deps);
    await handler(makeVoiceCtx());
    expect(fallbackTts.synthesize).toHaveBeenCalledTimes(1);
    expect(deps.sendVoice).toHaveBeenCalledTimes(1);
  });

  test('sends no voice when no TTS configured at all', async () => {
    const sendVoice = mock(() => Promise.resolve());
    const deps = makeVoiceDeps({ sendVoice });
    const handler = createMessageHandler(deps);
    const ctx = makeVoiceCtx();
    await handler(ctx);
    expect(sendVoice).toHaveBeenCalledTimes(0);
    // The transcription echo is the only chat message: neither the STT error nor the generic error was sent.
    expect(ctx.send).toHaveBeenCalledTimes(1);
    expect(ctx.send.mock.calls[0]?.[0]).toContain('Пользователь говорит');
  });

  test('uses fallbackTts for EN when kokoroTts throws', async () => {
    const kokoroTts = stub<KokoroTtsService>({ synthesize: mock(() => Promise.reject(new Error('kokoro down'))) });
    const fallbackTts = { synthesize: mock(() => Promise.resolve(audioBuffer)) };
    const deps = makeVoiceDeps({ kokoroTts, fallbackTts });
    const handler = createMessageHandler(deps);
    await handler(makeVoiceCtx({ ...voiceUser, language: 'en' }));
    expect(fallbackTts.synthesize).toHaveBeenCalledWith(expect.any(String), 'en');
    expect(deps.sendVoice).toHaveBeenCalledTimes(1);
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

    const intentRow: Intent = {
      id: 1,
      canonical_name: 'test_intent',
      phrases: '[]',
      trigger_words: '[]',
      pattern: null,
      workflow: JSON.stringify({ steps: [] }),
      format: 'text',
      status: 'approved',
      source_message: null,
      created_at: '2026-01-01 00:00:00',
    };
    const workflowSessions = {
      get: mock(() => null),
      set: mock(() => {}),
      delete: mock(() => {}),
      deleteByUser: mock(() => {}),
    };

    const deps = makeHandlerDeps({
      agent: stub({
        run: agentRun,
        getSender: mock(() => stub({})),
      }),
      eventService: stub({
        getEventsInRange: mock(() => []),
        getLatestCreated: mock(() => null),
        getEvent: mock(() => null),
      }),
      chatHistory: stub({
        save: mock(() => 1),
      }),
      intentMatcher: stub({
        match: mock(() => ({ intentId: 1, captures: {} })),
        load: mock(() => {}),
      }),
      intentRepo: stub({
        getById: mock(() => intentRow),
        currentRuleFingerprint: mock(() => 'rule-fingerprint'),
        runnableFingerprint: mock(() => 'rule-fingerprint'),
      }),
      intentExecutor: stub({
        run: mock(() => Promise.resolve({ success: true, response: 'Вот твои события.' })),
      }),
      workflowSessions,
    });
    const ctx = makeMessageCtx({ text: 'покажи события' });
    await createMessageHandler(deps)(ctx);

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
  const user = makeUserRow({ telegram_id: 1, language: 'ru', timezone: 'UTC' });

  test('passes userMemoryRepo into AgentContext', () => {
    const userMemoryRepo = stub<UserMemoryRepository>({
      getAll: mock(() => []),
      append: mock(() => {}),
      rewrite: mock(() => {}),
    });
    const deps = makeHandlerDeps({ userMemoryRepo, birthdayService: stub({}) });
    const ctx = buildAgentContextFactory(deps)(user, 1, 'hi');
    expect(ctx.birthday?.userMemoryRepo).toBe(userMemoryRepo);
  });

  test('AgentContext.userMemoryRepo is undefined when not provided in deps', () => {
    const ctx = buildAgentContextFactory(makeHandlerDeps())(user, 1, 'hi');
    expect(ctx.birthday?.userMemoryRepo).toBeUndefined();
  });
});
