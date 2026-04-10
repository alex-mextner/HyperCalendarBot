import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { UserMemoryRepository } from '../../../../src/database/repositories/user-memory.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleRememberUserFact, handleSetReaction } from '../../../../src/services/ai/tool-handlers/memory.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(db: Database, userId: number): AgentContext {
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: userId, timezone: 'UTC' });
  return {
    user: userRepo.findByTelegramId(userId)!,
    chatId: userId,
    messageText: '',
    isGroup: false,
    eventService: {} as AgentContext['eventService'],
    holidayService: {} as AgentContext['holidayService'],
    chatHistory: {} as AgentContext['chatHistory'],
    conversationLogger: null as never,
    userRepo,
    eventReminderRepo: {} as AgentContext['eventReminderRepo'],
    birthday: { birthdayService: undefined as never, userMemoryRepo: new UserMemoryRepository(db) },
  };
}

describe('handleRememberUserFact', () => {
  let db: Database;
  const USER_ID = 42;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
  });

  test('append adds a new fact', () => {
    const ctx = makeCtx(db, USER_ID);
    const result = handleRememberUserFact(ctx, { type: 'append', content: 'Prefers morning workouts' });
    expect(result.success).toBe(true);
    expect(ctx.birthday!.userMemoryRepo!.getAll(USER_ID)).toHaveLength(1);
    expect(ctx.birthday!.userMemoryRepo!.getAll(USER_ID)[0]!.content).toBe('Prefers morning workouts');
  });

  test('append accumulates multiple facts', () => {
    const ctx = makeCtx(db, USER_ID);
    handleRememberUserFact(ctx, { type: 'append', content: 'Fact 1' });
    handleRememberUserFact(ctx, { type: 'append', content: 'Fact 2' });
    expect(ctx.birthday!.userMemoryRepo!.getAll(USER_ID)).toHaveLength(2);
  });

  test('rewrite replaces all existing facts', () => {
    const ctx = makeCtx(db, USER_ID);
    handleRememberUserFact(ctx, { type: 'append', content: 'Old fact 1' });
    handleRememberUserFact(ctx, { type: 'append', content: 'Old fact 2' });
    handleRememberUserFact(ctx, { type: 'rewrite', content: 'New consolidated fact' });
    const facts = ctx.birthday!.userMemoryRepo!.getAll(USER_ID);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe('New consolidated fact');
  });

  test('returns error when userMemoryRepo is not available', () => {
    const ctx = makeCtx(db, USER_ID);
    const ctxWithout = {
      ...ctx,
      birthday: { birthdayService: undefined as never, userMemoryRepo: undefined as never },
    };
    const result = handleRememberUserFact(ctxWithout as AgentContext, { type: 'append', content: 'test' });
    expect(result.success).toBe(false);
  });
});

describe('handleSetReaction', () => {
  let db: Database;
  const USER_ID = 42;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
  });

  test('calls setReaction with groupChatId, messageId, and emoji', async () => {
    const ctx = makeCtx(db, USER_ID);
    const setReaction = mock(() => Promise.resolve());
    ctx.sender = { setReaction } as Partial<AgentContext['sender']> as AgentContext['sender'];
    ctx.isGroup = true;
    ctx.groupChatId = -100123;

    const result = await handleSetReaction(ctx, { message_id: 999, emoji: '👍' });

    expect(result.success).toBe(true);
    expect(setReaction).toHaveBeenCalledWith(-100123, 999, '👍');
  });

  test('falls back to chatId when groupChatId is absent', async () => {
    const ctx = makeCtx(db, USER_ID);
    const setReaction = mock(() => Promise.resolve());
    ctx.sender = { setReaction } as Partial<AgentContext['sender']> as AgentContext['sender'];
    ctx.isGroup = false;

    await handleSetReaction(ctx, { message_id: 7, emoji: '🤣' });

    expect(setReaction).toHaveBeenCalledWith(USER_ID, 7, '🤣');
  });

  test('returns error when setReaction is not available on sender', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.sender = {} as AgentContext['sender'];

    const result = await handleSetReaction(ctx, { message_id: 1, emoji: '👀' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Reactions not available');
  });

  test('returns error when sender is absent', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.sender = undefined;

    const result = await handleSetReaction(ctx, { message_id: 1, emoji: '👀' });

    expect(result.success).toBe(false);
  });

  test('set_reaction: awaits API and returns error on failure', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.sender = {
      setReaction: mock(() => Promise.reject(new Error('Bad Request: message not found'))),
    } as Partial<AgentContext['sender']> as AgentContext['sender'];
    ctx.groupChatId = -100123;
    const result = await handleSetReaction(ctx, { message_id: 999, emoji: '👍' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('message not found');
  });

  test('set_reaction: defaults to ctx.incomingMessageId when message_id omitted', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.incomingMessageId = 42;
    ctx.groupChatId = -100123;
    const setReaction = mock(() => Promise.resolve());
    ctx.sender = { setReaction } as Partial<AgentContext['sender']> as AgentContext['sender'];
    const result = await handleSetReaction(ctx, { emoji: '👍' });
    expect(result.success).toBe(true);
    expect(setReaction).toHaveBeenCalledWith(-100123, 42, '👍');
  });

  test('set_reaction: returns non-empty error when API throws with empty message', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.groupChatId = -100123;
    const emptyError = new Error('');
    ctx.sender = {
      setReaction: mock(() => Promise.reject(emptyError)),
    } as Partial<AgentContext['sender']> as AgentContext['sender'];
    const result = await handleSetReaction(ctx, { message_id: 1, emoji: '👍' });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('set_reaction: rejects unsupported emoji', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.groupChatId = -100123;
    ctx.sender = {
      setReaction: mock(() => Promise.resolve()),
    } as Partial<AgentContext['sender']> as AgentContext['sender'];
    const result = await handleSetReaction(ctx, { message_id: 1, emoji: '🖐' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not supported');
  });

  test('set_reaction: strips variation selector from emoji', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.groupChatId = -100123;
    const setReaction = mock(() => Promise.resolve());
    ctx.sender = { setReaction } as Partial<AgentContext['sender']> as AgentContext['sender'];
    // ❤️ = ❤ + U+FE0F variation selector
    const result = await handleSetReaction(ctx, { message_id: 1, emoji: '❤️' });
    expect(result.success).toBe(true);
    expect(setReaction).toHaveBeenCalledWith(-100123, 1, '❤');
  });

  test('set_reaction: returns error when no message_id and no incomingMessageId', async () => {
    const ctx = makeCtx(db, USER_ID);
    ctx.groupChatId = -100123;
    ctx.sender = {
      setReaction: mock(() => Promise.resolve()),
    } as Partial<AgentContext['sender']> as AgentContext['sender'];
    const result = await handleSetReaction(ctx, { emoji: '👍' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('message_id');
  });
});
