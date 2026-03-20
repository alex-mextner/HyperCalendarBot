import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { UserMemoryRepository } from '../../../../src/database/repositories/user-memory.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleRememberUserFact } from '../../../../src/services/ai/tool-handlers/memory.ts';
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
    userRepo,
    reminderRepo: {} as AgentContext['reminderRepo'],
    userMemoryRepo: new UserMemoryRepository(db),
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
    expect(ctx.userMemoryRepo!.getAll(USER_ID)).toHaveLength(1);
    expect(ctx.userMemoryRepo!.getAll(USER_ID)[0]!.content).toBe('Prefers morning workouts');
  });

  test('append accumulates multiple facts', () => {
    const ctx = makeCtx(db, USER_ID);
    handleRememberUserFact(ctx, { type: 'append', content: 'Fact 1' });
    handleRememberUserFact(ctx, { type: 'append', content: 'Fact 2' });
    expect(ctx.userMemoryRepo!.getAll(USER_ID)).toHaveLength(2);
  });

  test('rewrite replaces all existing facts', () => {
    const ctx = makeCtx(db, USER_ID);
    handleRememberUserFact(ctx, { type: 'append', content: 'Old fact 1' });
    handleRememberUserFact(ctx, { type: 'append', content: 'Old fact 2' });
    handleRememberUserFact(ctx, { type: 'rewrite', content: 'New consolidated fact' });
    const facts = ctx.userMemoryRepo!.getAll(USER_ID);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.content).toBe('New consolidated fact');
  });

  test('returns error when userMemoryRepo is not available', () => {
    const ctx = makeCtx(db, USER_ID);
    const ctxWithout = { ...ctx, userMemoryRepo: undefined };
    const result = handleRememberUserFact(ctxWithout as AgentContext, { type: 'append', content: 'test' });
    expect(result.success).toBe(false);
  });
});
