// test/services/intent/intent-learner.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { IntentLearner } from '../../../src/services/intent/intent-learner.ts';

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

  test('respects daily budget cap', async () => {
    // Fill up the budget
    for (let i = 0; i < 100; i++) {
      learner.incrementCounter();
    }
    const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
    expect(result).toBeNull();
  });

  test('deduplicates within 1 hour window', async () => {
    // First call - will try to call API (and fail, which is fine for dedup test)
    await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]).catch(() => {});

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
      workflow: { tools: [{ name: 'get_events', input: { date: '{{today}}' } }] },
      format: 'events_list',
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(intentPayload)}\n\`\`\`` }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

    try {
      const result = await learner.analyze('что сегодня', [{ name: 'get_events', input: {} }], [{ success: true }]);
      expect(result?.canonical_name).toBe('show_today');
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
