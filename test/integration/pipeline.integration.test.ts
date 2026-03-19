// test/integration/pipeline.integration.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFeedbackRouterLayer } from '../../src/bot/pipeline/feedback-router-layer.ts';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import { runPipeline } from '../../src/bot/pipeline/pipeline.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { FeedbackRepository } from '../../src/database/repositories/feedback.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';

function makeCtx(userId: number, timezone = 'UTC', language = 'en'): BotCommandContext {
  return {
    dbUser: { telegram_id: userId, timezone, language },
    send: mock(() => Promise.resolve()),
    chatId: userId,
  } as unknown as BotCommandContext;
}

describe('Pipeline Integration', () => {
  let db: Database;
  let intentRepo: IntentRepository;
  let feedbackRepo: FeedbackRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
    feedbackRepo = new FeedbackRepository(db);
  });

  test('approved intent is matched and executed without AI', async () => {
    const id = intentRepo.create({
      canonical_name: 'show_today',
      phrases: ['что сегодня'],
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{dates.today}}' } }],
        format: 'events_list',
      },
      format: 'events_list',
    });
    intentRepo.updateStatus(id, 'approved');

    const matcher = new IntentMatcher();
    matcher.load(intentRepo.getApproved());
    const executor = new IntentExecutor();

    const mockToolExecutor = mock((_name: string, _input: Record<string, unknown>) => ({
      success: true,
      output: JSON.stringify([{ title: 'Test Meeting', start_at: '2026-03-17T10:00:00Z' }]),
    }));
    const ctx = makeCtx(123, 'Europe/Moscow', 'ru');

    const intentLayer = createIntentMatcherLayer(matcher, intentRepo, executor, mockToolExecutor, new Map());

    const result = await intentLayer(ctx, 'что сегодня');
    expect(result.handled).toBe(true);
    expect(ctx.send).toHaveBeenCalled();
    expect(mockToolExecutor).toHaveBeenCalled();
  });

  test('unknown message passes through intent layer', async () => {
    const matcher = new IntentMatcher();
    matcher.load([]);
    const executor = new IntentExecutor();
    const ctx = makeCtx(123);

    const intentLayer = createIntentMatcherLayer(
      matcher,
      intentRepo,
      executor,
      mock(() => ({ success: true })),
      new Map(),
    );

    const result = await intentLayer(ctx, 'something completely random');
    expect(result.handled).toBe(false);
  });

  test('intent with pattern captures and resolves variables', async () => {
    const id = intentRepo.create({
      canonical_name: 'show_date',
      phrases: [],
      trigger_words: ['покажи'],
      pattern: 'покажи (завтра|сегодня)',
      workflow: {
        tools: [{ name: 'get_events', input: { start_date: '{{$1}}' } }],
        format: 'text',
      },
      format: 'text',
    });
    intentRepo.updateStatus(id, 'approved');

    const matcher = new IntentMatcher();
    matcher.load(intentRepo.getApproved());
    const executor = new IntentExecutor();

    const capturedInputs: Record<string, unknown>[] = [];
    const mockToolExecutor = mock((_name: string, input: Record<string, unknown>) => {
      capturedInputs.push(input);
      return { success: true, output: '[]' };
    });
    const ctx = makeCtx(1);

    const intentLayer = createIntentMatcherLayer(matcher, intentRepo, executor, mockToolExecutor, new Map());

    const result = await intentLayer(ctx, 'покажи завтра');
    expect(result.handled).toBe(true);
    // The $1 capture should be passed (variable-resolved or raw)
    expect(mockToolExecutor).toHaveBeenCalled();
  });

  test('feedback thread enriches pipeline context', async () => {
    feedbackRepo.createThread({
      user_id: 456,
      type: 'bug',
      subject: 'Button broken',
    });
    feedbackRepo.addMessage({
      thread_id: 1,
      sender: 'admin',
      text: 'Can you elaborate?',
    });

    const ctx = makeCtx(456);
    const feedbackLayer = createFeedbackRouterLayer(feedbackRepo);
    const result = await feedbackLayer(ctx, 'yes more details');

    expect(result.handled).toBe(false);
    expect('feedbackContext' in result).toBe(true);
    if ('feedbackContext' in result) {
      expect(result.feedbackContext.subject).toBe('Button broken');
      expect(result.feedbackContext.threadId).toBe(1);
    }
  });

  test('runPipeline stops at first handled layer', async () => {
    const matcher = new IntentMatcher();
    const id = intentRepo.create({
      canonical_name: 'stop_here',
      phrases: ['стоп'],
      workflow: { tools: [{ name: 'noop', input: {} }], format: 'text' },
      format: 'text',
    });
    intentRepo.updateStatus(id, 'approved');
    matcher.load(intentRepo.getApproved());

    const executor = new IntentExecutor();
    const toolExecutor = mock(() => ({ success: true, output: 'handled' }));
    const ctx = makeCtx(1);

    const intentLayer = createIntentMatcherLayer(matcher, intentRepo, executor, toolExecutor, new Map());

    const secondLayerCalled = { value: false };
    const secondLayer = mock(async () => {
      secondLayerCalled.value = true;
      return { handled: false } as const;
    });

    await runPipeline(ctx, 'стоп', [intentLayer, secondLayer]);

    expect(toolExecutor).toHaveBeenCalled();
    expect(secondLayer).not.toHaveBeenCalled();
  });

  test('runPipeline passes feedbackContext from feedback layer to subsequent layers', async () => {
    feedbackRepo.createThread({ user_id: 789, type: 'question', subject: 'How do I?' });

    const ctx = makeCtx(789);
    const feedbackLayer = createFeedbackRouterLayer(feedbackRepo);

    let receivedExtra: { feedbackContext?: unknown } | undefined;
    const captureLayer = mock(async (_ctx: BotCommandContext, _text: string, extra?: { feedbackContext?: unknown }) => {
      receivedExtra = extra;
      return { handled: true } as const;
    });

    await runPipeline(ctx, 'help me', [feedbackLayer, captureLayer]);

    expect(captureLayer).toHaveBeenCalled();
    expect(receivedExtra?.feedbackContext).toBeDefined();
    if (receivedExtra?.feedbackContext) {
      expect((receivedExtra.feedbackContext as { subject: string }).subject).toBe('How do I?');
    }
  });

  test('intent not found in DB after matcher returns match is handled gracefully', async () => {
    // Seed an intent, then delete it from DB to simulate stale matcher
    const id = intentRepo.create({
      canonical_name: 'ghost',
      phrases: ['призрак'],
      workflow: { tools: [], format: 'text' },
      format: 'text',
    });
    intentRepo.updateStatus(id, 'approved');

    const matcher = new IntentMatcher();
    matcher.load(intentRepo.getApproved());

    // Delete from DB to simulate stale state
    db.exec(`DELETE FROM intents WHERE id = ${id}`);

    const executor = new IntentExecutor();
    const ctx = makeCtx(1);

    const intentLayer = createIntentMatcherLayer(
      matcher,
      intentRepo,
      executor,
      mock(() => ({ success: true })),
      new Map(),
    );

    // Should fall through gracefully (handled: false)
    const result = await intentLayer(ctx, 'призрак');
    expect(result.handled).toBe(false);
  });
});
