import { describe, expect, mock, test } from 'bun:test';
import { createFeedbackRouterLayer } from '../../../src/bot/pipeline/feedback-router-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { FeedbackRepository } from '../../../src/database/repositories/feedback.repository.ts';

function makeCtx(userId = 1): BotCommandContext {
  return {
    dbUser: { telegram_id: userId, language: 'ru', timezone: 'UTC' },
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

function makeFeedbackRepo(
  thread: Record<string, unknown> | null,
  messages: Record<string, unknown>[] = [],
): FeedbackRepository {
  return {
    getOpenThreadForUser: mock(() => thread),
    getMessages: mock(() => messages),
  } as unknown as FeedbackRepository;
}

describe('createFeedbackRouterLayer', () => {
  test('returns handled:false without feedbackContext when no open thread', async () => {
    const layer = createFeedbackRouterLayer(makeFeedbackRepo(null));
    const result = await layer(makeCtx());

    expect(result.handled).toBe(false);
    expect('feedbackContext' in result).toBe(false);
  });

  test('returns handled:false with feedbackContext when open thread exists', async () => {
    const thread = { id: 10, user_id: 1, status: 'open', subject: 'Bug report' };
    const messages = [
      { id: 1, thread_id: 10, sender: 'user', text: 'app crashes' },
      { id: 2, thread_id: 10, sender: 'admin', text: 'checking' },
    ];
    const layer = createFeedbackRouterLayer(makeFeedbackRepo(thread, messages));
    const result = await layer(makeCtx());

    expect(result.handled).toBe(false);
    expect('feedbackContext' in result).toBe(true);

    const ctx = result as {
      handled: false;
      feedbackContext: { threadId: number; subject: string; messages: { sender: string; text: string }[] };
    };
    expect(ctx.feedbackContext.threadId).toBe(10);
    expect(ctx.feedbackContext.subject).toBe('Bug report');
    expect(ctx.feedbackContext.messages).toHaveLength(2);
    expect(ctx.feedbackContext.messages[0]).toEqual({ sender: 'user', text: 'app crashes' });
  });

  test('trims messages to last 10 when there are many', async () => {
    const thread = { id: 5, user_id: 2, status: 'open', subject: 'Long thread' };
    const messages = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      thread_id: 5,
      sender: i % 2 === 0 ? 'user' : 'admin',
      text: `message ${i + 1}`,
    }));

    const layer = createFeedbackRouterLayer(makeFeedbackRepo(thread, messages));
    const result = await layer(makeCtx(2));

    expect(result.handled).toBe(false);
    const ctx = result as { handled: false; feedbackContext: { messages: unknown[] } };
    expect(ctx.feedbackContext.messages).toHaveLength(10);
  });

  test('queried with correct userId from ctx.dbUser', async () => {
    const repo = makeFeedbackRepo(null);
    const layer = createFeedbackRouterLayer(repo);
    await layer(makeCtx(99));

    expect(repo.getOpenThreadForUser).toHaveBeenCalledWith(99);
  });
});
