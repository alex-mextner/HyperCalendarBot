import { describe, expect, mock, test } from 'bun:test';
import { createFeedbackRouterLayer } from '../../../src/bot/pipeline/feedback-router-layer.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import type { FeedbackMessage, FeedbackThread, User } from '../../../src/database/types.ts';

/** BotCommandContext extends MessageContext; the layer only uses dbUser. */
function makeCtx(userId = 1): BotCommandContext {
  return {
    dbUser: { telegram_id: userId, language: 'ru', timezone: 'UTC' } as User,
    send: mock(() => Promise.resolve()),
  } as unknown as BotCommandContext;
}

/** Mock only the methods createFeedbackRouterLayer actually uses. */
interface MockFeedbackRepo {
  getOpenThreadForUser: ReturnType<typeof mock<(userId: number) => Partial<FeedbackThread> | null>>;
  getMessages: ReturnType<typeof mock<(threadId: number) => Partial<FeedbackMessage>[]>>;
}

function makeFeedbackRepo(
  thread: Partial<FeedbackThread> | null,
  messages: Partial<FeedbackMessage>[] = [],
): MockFeedbackRepo {
  return {
    getOpenThreadForUser: mock(() => thread),
    getMessages: mock(() => messages),
  };
}

/** Single boundary cast: FeedbackRepository is a class with private `db` member */
function makeLayer(repo: MockFeedbackRepo) {
  return createFeedbackRouterLayer(repo as unknown as Parameters<typeof createFeedbackRouterLayer>[0]);
}

describe('createFeedbackRouterLayer', () => {
  test('returns handled:false without feedbackContext when no open thread', async () => {
    const layer = makeLayer(makeFeedbackRepo(null));
    const result = await layer(makeCtx());

    expect(result.handled).toBe(false);
    expect('feedbackContext' in result).toBe(false);
  });

  test('returns handled:false with feedbackContext when open thread exists', async () => {
    const thread: Partial<FeedbackThread> = { id: 10, user_id: 1, status: 'open', subject: 'Bug report' };
    const messages: Partial<FeedbackMessage>[] = [
      { id: 1, thread_id: 10, sender: 'user', text: 'app crashes' },
      { id: 2, thread_id: 10, sender: 'admin', text: 'checking' },
    ];
    const layer = makeLayer(makeFeedbackRepo(thread, messages));
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
    const thread: Partial<FeedbackThread> = { id: 5, user_id: 2, status: 'open', subject: 'Long thread' };
    const messages: Partial<FeedbackMessage>[] = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      thread_id: 5,
      sender: (i % 2 === 0 ? 'user' : 'admin') as 'user' | 'admin',
      text: `message ${i + 1}`,
    }));

    const layer = makeLayer(makeFeedbackRepo(thread, messages));
    const result = await layer(makeCtx(2));

    expect(result.handled).toBe(false);
    const ctx = result as { handled: false; feedbackContext: { messages: { sender: string; text: string }[] } };
    expect(ctx.feedbackContext.messages).toHaveLength(10);
  });

  test('queried with correct userId from ctx.dbUser', async () => {
    const repo = makeFeedbackRepo(null);
    const layer = makeLayer(repo);
    await layer(makeCtx(99));

    expect(repo.getOpenThreadForUser).toHaveBeenCalledWith(99);
  });
});
