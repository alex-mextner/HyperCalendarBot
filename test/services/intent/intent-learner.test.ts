// test/services/intent/intent-learner.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type OpenAI from 'openai';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { IntentLearner } from '../../../src/services/intent/intent-learner.ts';
import { cmdLogger } from '../../../src/utils/logger.ts';

/**
 * Build a streamImpl stub that returns a canned text response on each call.
 * The script is consumed in order; any extra calls re-use the last entry.
 * Tests that need an error simply throw inside the returned promise.
 */
function makeStreamStub(
  textsOrError: string[] | (() => Promise<string>),
): (opts: StreamRoundOptions) => Promise<StreamRoundResult> {
  if (typeof textsOrError === 'function') {
    return async () => {
      const text = await textsOrError();
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
      return { text, toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    };
  }
  let call = 0;
  return async () => {
    const text = textsOrError[Math.min(call, textsOrError.length - 1)] ?? '';
    call++;
    const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
    return { text, toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
  };
}

function makeTruncatedStub(text: string): (opts: StreamRoundOptions) => Promise<StreamRoundResult> {
  return async () => {
    const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
    return { text, toolCalls: [], finishReason: 'length', assistantMessage: msg, providerUsed: 'stub' };
  };
}

describe('IntentLearner', () => {
  let db: Database;
  let intentRepo: IntentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
  });

  const buildLearner = (streamImpl?: (opts: StreamRoundOptions) => Promise<StreamRoundResult>) =>
    new IntentLearner(intentRepo, { dailyLimit: 100, streamImpl });

  test('skips when no tool calls (chat response)', async () => {
    const learner = buildLearner();
    const result = await learner.analyze('привет', [], []);
    expect(result).toBeNull();
  });

  test('skips when ask_user was called', async () => {
    const learner = buildLearner();
    const result = await learner.analyze('delete it', [{ name: 'ask_user', input: {} }], []);
    expect(result).toBeNull();
  });

  test('skips contextual messages with pronouns', async () => {
    const learner = buildLearner();
    const result = await learner.analyze(
      'перенеси это на завтра',
      [{ name: 'update_event', input: {} }],
      [{ success: true }],
    );
    expect(result).toBeNull();
  });

  test('skips Cyrillic pronouns without word boundary false negatives', async () => {
    const learner = buildLearner();
    for (const msg of ['удали это', 'его отмени', 'её перенеси', 'их удали']) {
      const result = await learner.analyze(msg, [{ name: 'delete_event', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
    }
  });

  test('respects daily budget cap', async () => {
    let aiCalled = false;
    const learner = buildLearner(async () => {
      aiCalled = true;
      throw new Error('should not be reached — budget should have blocked the call');
    });
    // Simulate a fresh analyze() call so resetDailyIfNeeded() initializes lastResetDate,
    // then push the counter to the cap. Without this, the first analyze() call would
    // reset the counter to 0.
    await learner.analyze('примем звонок', [{ name: 'make_call', input: {} }], [{ success: true }]).catch(() => {});
    for (let i = 0; i < 100; i++) {
      learner.incrementCounter();
    }
    aiCalled = false;

    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
    expect(aiCalled).toBe(false);
  });

  test('deduplicates within 1 hour window', async () => {
    // First call: return null (invalid schema triggers ZodError → caught → null)
    const learner = buildLearner(makeStreamStub(['not json']));
    await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);

    learner.resetDailyCounter();
    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
  });

  test('parses JSON wrapped in markdown code fences', async () => {
    const intentPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня', 'events today'],
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}' } }],
      },
      format: 'events_list',
    };
    const learner = buildLearner(makeStreamStub([`\`\`\`json\n${JSON.stringify(intentPayload)}\n\`\`\``]));

    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result?.canonical_name).toBe('show_today');
  });

  test('creates intent and logs when admin notification is not configured (issue #51)', async () => {
    // Regression: sendToAdminForVerification silently returned when adminId/sendToAdmin
    // were absent — candidate intents piled up unverified with no signal anywhere.
    const intentPayload = {
      canonical_name: 'show_today_unverified',
      phrases: ['что сегодня без админа'],
      workflow: { tools: [{ name: 'get_events', input: { date: '{{dates.today}}' } }] },
      format: 'events_list',
    };
    const learner = buildLearner(makeStreamStub([JSON.stringify(intentPayload)]));

    const warnSpy = spyOn(cmdLogger, 'warn').mockImplementation(() => {});
    try {
      const result = await learner.analyze(
        'что сегодня без админа',
        [{ name: 'get_events', input: {} }],
        [{ success: true }],
      );
      expect(result?.canonical_name).toBe('show_today_unverified');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ hasAdminId: false, hasSendToAdmin: false }),
        expect.stringContaining('admin notification not configured'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('returns null silently when stream finishReason is "length" (truncated)', async () => {
    const truncatedJson = '{"canonical_name":"show_today","phrases":["что сегодня"],"workflow":{';
    const learner = buildLearner(makeTruncatedStub(truncatedJson));

    const warnSpy = spyOn(cmdLogger, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(cmdLogger, 'error').mockImplementation(() => {});

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('returns null silently when AI returns skip-only response {"skip":true}', async () => {
    const learner = buildLearner(makeStreamStub(['{"skip":true}']));

    const errorSpy = spyOn(cmdLogger, 'error').mockImplementation(() => {});

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('retries when first response has invalid variables, succeeds on second', async () => {
    const invalidPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{unknown_var}}', end_date: '{{dates.today}}' } }],
      },
      format: 'events_list',
    };
    const validPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}' } }],
      },
      format: 'events_list',
    };

    let callCount = 0;
    const learner = buildLearner(async () => {
      callCount++;
      const payload = callCount === 1 ? invalidPayload : validPayload;
      const text = JSON.stringify(payload);
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
      return { text, toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    });

    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result?.canonical_name).toBe('show_today');
    expect(callCount).toBe(2);
  });

  test('returns null after all 5 retries fail with invalid variables', async () => {
    const invalidPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: { tools: [{ name: 'get_events', input: { start_date: '{{bad_var}}', end_date: '{{dates.today}}' } }] },
      format: 'events_list',
    };

    let callCount = 0;
    const learner = buildLearner(async () => {
      callCount++;
      const text = JSON.stringify(invalidPayload);
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
      return { text, toolCalls: [], finishReason: 'stop', assistantMessage: msg, providerUsed: 'stub' };
    });

    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
    expect(callCount).toBe(6); // 1 initial + 5 retries
  });

  test('does not crash when AI returns null for optional pattern field', async () => {
    const intentPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня', 'events today'],
      pattern: null,
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}' } }],
      },
      format: 'text',
    };
    const learner = buildLearner(makeStreamStub([JSON.stringify(intentPayload)]));

    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result?.canonical_name).toBe('show_today');
    expect(result?.pattern).toBeUndefined();
  });

  test('accepts empty phrases when pattern is present', async () => {
    const intentPayload = {
      canonical_name: 'get_time_in_timezone',
      phrases: [],
      trigger_words: ['час', 'время'],
      pattern: '^(?:который час|время)\\s+(?:в|in)\\s+(.+)$',
      workflow: { steps: [{ call: 'get_timezone_info', input: { timezone: '{{$1}}', at: '{{dates.now}}' } }] },
      format: 'text',
    };
    const learner = buildLearner(makeStreamStub([JSON.stringify(intentPayload)]));

    const result = await learner.analyze(
      'который час в москве',
      [{ name: 'get_timezone_info', input: {} }],
      [{ success: true }],
    );
    expect(result?.canonical_name).toBe('get_time_in_timezone');
    expect(result?.phrases).toEqual([]);
    expect(result?.pattern).toBe('^(?:который час|время)\\s+(?:в|in)\\s+(.+)$');
  });

  test('rejects empty phrases when no pattern', async () => {
    const intentPayload = {
      canonical_name: 'broken_intent',
      phrases: [],
      workflow: { steps: [{ call: 'get_events', input: { start_date: '{{dates.today}}' } }] },
      format: 'text',
    };
    const learner = buildLearner(makeStreamStub([JSON.stringify(intentPayload)]));

    const result = await learner.analyze('что-то', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
  });

  test('resets daily counter on new day', () => {
    const learner = buildLearner();
    for (let i = 0; i < 50; i++) {
      learner.incrementCounter();
    }
    expect(learner.getDailyCallCount()).toBe(50);
    learner.resetDailyCounter();
    expect(learner.getDailyCallCount()).toBe(0);
  });
});
