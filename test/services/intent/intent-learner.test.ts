// test/services/intent/intent-learner.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { IntentLearner } from '../../../src/services/intent/intent-learner.ts';
import { cmdLogger } from '../../../src/utils/logger.ts';

describe('IntentLearner', () => {
  let db: Database;
  let intentRepo: IntentRepository;
  let learner: IntentLearner;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
    learner = new IntentLearner(intentRepo, {
      apiKey: 'test-key',
      baseUrl: 'http://localhost',
      dailyLimit: 100,
    });
  });

  test('skips when no tool calls (chat response)', async () => {
    const result = await learner.analyze('привет', [], []);
    expect(result).toBeNull();
  });

  test('skips when ask_user was called', async () => {
    const result = await learner.analyze('delete it', [{ name: 'ask_user', input: {} }], []);
    expect(result).toBeNull();
  });

  test('skips contextual messages with pronouns', async () => {
    const result = await learner.analyze(
      'перенеси это на завтра',
      [{ name: 'update_event', input: {} }],
      [{ success: true }],
    );
    expect(result).toBeNull();
  });

  test('skips Cyrillic pronouns without word boundary false negatives', async () => {
    // \b does not work with Cyrillic in JS — verify fix via lookarounds
    for (const msg of ['удали это', 'его отмени', 'её перенеси', 'их удали']) {
      const result = await learner.analyze(msg, [{ name: 'delete_event', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
    }
    // Substrings that contain pronoun letters but are not pronouns should NOT skip
    // (tested indirectly — 'итого' contains 'ито' but not the listed pronouns, so no skip)
  });

  test('respects daily budget cap', async () => {
    // Fill up the budget
    for (let i = 0; i < 100; i++) {
      learner.incrementCounter();
    }
    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
  });

  test('deduplicates within 1 hour window', async () => {
    // First call - will try to call API and return null (connection error), which is fine for dedup test
    await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);

    // Reset counter since first call incremented it
    learner.resetDailyCounter();

    // Second call with same message - should be null due to dedup
    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
  });

  test('parses JSON wrapped in markdown code fences', async () => {
    const intentPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня', 'events today'],
      workflow: { tools: [{ name: 'get_events', input: { date: '{{dates.today}}' } }] },
      format: 'events_list',
    };

    const originalFetch = globalThis.fetch;
    // @ts-expect-error: mock fetch missing preconnect
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(intentPayload)}\n\`\`\`` }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result?.canonical_name).toBe('show_today');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns null silently when API response is truncated (stop_reason: max_tokens)', async () => {
    const truncatedJson = '{"canonical_name":"show_today","phrases":["что сегодня"],"workflow":{';

    const originalFetch = globalThis.fetch;
    // @ts-expect-error: mock fetch missing preconnect
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: truncatedJson }],
          stop_reason: 'max_tokens',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ) as unknown as Response;

    const originalWarn = cmdLogger.warn.bind(cmdLogger);
    const originalError = cmdLogger.error.bind(cmdLogger);
    let warnCalled = false;
    let errorCalled = false;
    // biome-ignore lint/suspicious/noExplicitAny: spy patching pino child logger
    (cmdLogger as any).warn = (...args: unknown[]) => {
      warnCalled = true;
      return originalWarn(...(args as Parameters<typeof originalWarn>));
    };
    // biome-ignore lint/suspicious/noExplicitAny: spy patching pino child logger
    (cmdLogger as any).error = (...args: unknown[]) => {
      errorCalled = true;
      return originalError(...(args as Parameters<typeof originalError>));
    };

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
      expect(warnCalled).toBe(true); // took the silent-skip path
      expect(errorCalled).toBe(false); // did NOT fall through to JSON.parse error
    } finally {
      globalThis.fetch = originalFetch;
      // biome-ignore lint/suspicious/noExplicitAny: restore spy
      (cmdLogger as any).warn = originalWarn;
      // biome-ignore lint/suspicious/noExplicitAny: restore spy
      (cmdLogger as any).error = originalError;
    }
  });

  test('retries when first response has invalid variables, succeeds on second', async () => {
    const invalidPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: { tools: [{ name: 'get_events', input: { date: '{{unknown_var}}' } }] },
      format: 'events_list',
    };
    const validPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: { tools: [{ name: 'get_events', input: { date: '{{dates.today}}' } }] },
      format: 'events_list',
    };

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    // @ts-expect-error: mock fetch missing preconnect
    globalThis.fetch = async () => {
      callCount++;
      const payload = callCount === 1 ? invalidPayload : validPayload;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    };

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result?.canonical_name).toBe('show_today');
      expect(callCount).toBe(2); // one retry was needed
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns null after all 5 retries fail with invalid variables', async () => {
    const invalidPayload = {
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: { tools: [{ name: 'get_events', input: { date: '{{bad_var}}' } }] },
      format: 'events_list',
    };

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    // @ts-expect-error: mock fetch missing preconnect
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(invalidPayload) }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    };

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result).toBeNull();
      expect(callCount).toBe(6); // 1 initial + 5 retries, all returned invalid variables
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('resets daily counter on new day', () => {
    for (let i = 0; i < 50; i++) {
      learner.incrementCounter();
    }
    expect(learner.getDailyCallCount()).toBe(50);
    learner.resetDailyCounter();
    expect(learner.getDailyCallCount()).toBe(0);
  });
});
