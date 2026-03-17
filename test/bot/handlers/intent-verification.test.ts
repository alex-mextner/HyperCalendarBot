// test/bot/handlers/intent-verification.test.ts

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { createMessageHandler } from '../../../src/bot/handlers/message.handler.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

describe('intent verification callbacks', () => {
  let db: Database;
  let intentRepo: IntentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
  });

  test('accept changes status to approved', () => {
    const id = intentRepo.create({
      canonical_name: 'test_intent',
      phrases: ['test'],
      workflow: { tools: [] },
      format: 'text',
    });
    intentRepo.updateStatus(id, 'approved');
    expect(intentRepo.getById(id)!.status).toBe('approved');
  });

  test('reject changes status to rejected', () => {
    const id = intentRepo.create({
      canonical_name: 'test2',
      phrases: ['test2'],
      workflow: { tools: [] },
      format: 'text',
    });
    intentRepo.updateStatus(id, 'rejected');
    expect(intentRepo.getById(id)!.status).toBe('rejected');
  });

  test('edit sets admin edit session', () => {
    const sessions = new Map<number, { intentId: number; state: 'awaiting_instructions' }>();
    const adminId = 12345;
    const intentId = 42;
    sessions.set(adminId, { intentId, state: 'awaiting_instructions' });
    expect(sessions.has(adminId)).toBe(true);
    expect(sessions.get(adminId)!.intentId).toBe(intentId);
  });
});

describe('intent_accept callback handler', () => {
  let db: Database;
  let intentRepo: IntentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
  });

  function makeCtx(data: string, overrides: Record<string, unknown> = {}) {
    return {
      data,
      dbUser: { telegram_id: 999, language: 'en', timezone: 'UTC' },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
      message: { chat: { id: 999 }, send: mock(() => Promise.resolve()) },
      chat: { id: 999 },
      ...overrides,
    };
  }

  function makeHandler(intentRepoArg: IntentRepository, intentMatcher?: { reload: () => void }) {
    return createCallbackHandler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { intentRepo: intentRepoArg, intentMatcher },
    );
  }

  test('intent_accept sets status to approved', async () => {
    const id = intentRepo.create({
      canonical_name: 'greet',
      phrases: ['hello'],
      workflow: { tools: [] },
      format: 'text',
    });
    const handler = makeHandler(intentRepo);
    const ctx = makeCtx(`intent_accept:${id}`);
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith('Intent approved ✅');
    expect(intentRepo.getById(id)!.status).toBe('approved');
    expect(ctx.editText).toHaveBeenCalled();
    const editArg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editArg).toContain('✅ APPROVED');
  });

  test('intent_accept calls intentMatcher.reload()', async () => {
    const id = intentRepo.create({
      canonical_name: 'reload_test',
      phrases: ['reload'],
      workflow: { tools: [] },
      format: 'text',
    });
    const intentMatcher = { reload: mock(() => {}) };
    const handler = makeHandler(intentRepo, intentMatcher);
    const ctx = makeCtx(`intent_accept:${id}`);
    await handler(ctx as never);
    expect(intentMatcher.reload).toHaveBeenCalledTimes(1);
  });

  test('intent_reject sets status to rejected', async () => {
    const id = intentRepo.create({
      canonical_name: 'reject_test',
      phrases: ['bye'],
      workflow: { tools: [] },
      format: 'text',
    });
    const handler = makeHandler(intentRepo);
    const ctx = makeCtx(`intent_reject:${id}`);
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith('Intent rejected ❌');
    expect(intentRepo.getById(id)!.status).toBe('rejected');
    expect(ctx.editText).toHaveBeenCalled();
    const editArg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editArg).toContain('❌ REJECTED');
  });

  test('intent_edit stores admin edit session and answers', async () => {
    const adminEditSessions = new Map<
      number,
      { intentId: number; state: 'awaiting_instructions'; createdAt: number }
    >();
    const adminId = 999;
    const intentId = intentRepo.create({
      canonical_name: 'edit_test',
      phrases: ['edit me'],
      workflow: { tools: [] },
      format: 'text',
    });

    const handler = createCallbackHandler(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { intentRepo, adminEditSessions },
    );

    const ctx = makeCtx(`intent_edit:${intentId}`);
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith('Send edit instructions...');
    expect(adminEditSessions.has(adminId)).toBe(true);
    expect(adminEditSessions.get(adminId)!.intentId).toBe(intentId);
    expect(adminEditSessions.get(adminId)!.state).toBe('awaiting_instructions');
  });
});

describe('admin edit session in message handler', () => {
  let db: Database;
  let intentRepo: IntentRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    intentRepo = new IntentRepository(db);
  });

  test('admin edit session expired entries are cleared on access', () => {
    const sessions = new Map<number, { intentId: number; state: 'awaiting_instructions'; createdAt: number }>();
    const adminId = 100;
    // Set an expired session (11 minutes ago)
    sessions.set(adminId, {
      intentId: 1,
      state: 'awaiting_instructions',
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    // Simulate TTL check
    const session = sessions.get(adminId);
    if (session && Date.now() - session.createdAt > 10 * 60 * 1000) {
      sessions.delete(adminId);
    }
    expect(sessions.has(adminId)).toBe(false);
  });

  test('admin edit session within TTL is kept', () => {
    const sessions = new Map<number, { intentId: number; state: 'awaiting_instructions'; createdAt: number }>();
    const adminId = 100;
    sessions.set(adminId, {
      intentId: 1,
      state: 'awaiting_instructions',
      createdAt: Date.now() - 2 * 60 * 1000, // 2 minutes ago
    });
    const session = sessions.get(adminId);
    if (session && Date.now() - session.createdAt > 10 * 60 * 1000) {
      sessions.delete(adminId);
    }
    expect(sessions.has(adminId)).toBe(true);
  });

  test('admin edit session is consumed when admin sends instruction', async () => {
    const intentId = intentRepo.create({
      canonical_name: 'msg_edit_test',
      phrases: ['foo'],
      workflow: { tools: [] },
      format: 'text',
    });

    const adminId = 42;
    const adminEditSessions = new Map<
      number,
      { intentId: number; state: 'awaiting_instructions'; createdAt: number }
    >();
    adminEditSessions.set(adminId, { intentId, state: 'awaiting_instructions', createdAt: Date.now() });

    // Mock AI call to return updated intent
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                phrases: ['bar', 'baz'],
                workflow: { tools: ['list_events'] },
                format: 'text',
              }),
            },
          ],
        }),
      );
    }) as typeof fetch;

    try {
      const sendMsg = mock(() => Promise.resolve());
      const deps = {
        agent: { run: mock(() => Promise.resolve()) },
        eventService: {},
        holidayService: {},
        chatHistory: {},
        userRepo: {},
        reminderRepo: {},
        sceneStorage: { get: mock(() => Promise.resolve(null)) },
        botAdminId: adminId,
        adminEditSessions,
        intentRepo,
        aiBaseUrl: 'https://api.anthropic.com',
        aiApiKey: 'test-key',
        sendMessageToUser: sendMsg,
      };

      const handler = createMessageHandler(deps as never);
      const ctx = {
        dbUser: { telegram_id: adminId, language: 'en', timezone: 'UTC' },
        text: 'change phrases to bar and baz',
        chatId: adminId,
        chat: { type: 'private' },
        from: { first_name: 'Admin' },
        send: mock(() => Promise.resolve()),
      };

      await handler(ctx as never);

      // Session should be consumed
      expect(adminEditSessions.has(adminId)).toBe(false);
      // send should have been called with preview
      expect(ctx.send).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('non-admin message is not treated as edit instruction', async () => {
    const intentId = intentRepo.create({
      canonical_name: 'not_admin_test',
      phrases: ['hello'],
      workflow: { tools: [] },
      format: 'text',
    });

    const adminId = 42;
    const adminEditSessions = new Map<
      number,
      { intentId: number; state: 'awaiting_instructions'; createdAt: number }
    >();
    adminEditSessions.set(adminId, { intentId, state: 'awaiting_instructions', createdAt: Date.now() });

    const agentRun = mock(() => Promise.resolve());
    const deps = {
      agent: { run: agentRun },
      eventService: {},
      holidayService: {},
      chatHistory: {},
      userRepo: {},
      reminderRepo: {},
      sceneStorage: { get: mock(() => Promise.resolve(null)) },
      botAdminId: adminId,
      adminEditSessions,
      intentRepo,
    };

    const handler = createMessageHandler(deps as never);
    const ctx = {
      dbUser: { telegram_id: 999, language: 'en', timezone: 'UTC' }, // NOT admin
      text: 'change phrases to bar',
      chatId: 999,
      chat: { type: 'private' },
      from: { first_name: 'User' },
      send: mock(() => Promise.resolve()),
    };

    await handler(ctx as never);

    // Session should still be present (wasn't consumed)
    expect(adminEditSessions.has(adminId)).toBe(true);
    // Agent should have been called since it's a non-admin message
    expect(agentRun).toHaveBeenCalledTimes(1);
  });
});
