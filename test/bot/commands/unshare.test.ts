// test/bot/commands/unshare.test.ts
import { describe, expect, mock, test } from 'bun:test';
import type { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository';

function makeCtx(args: string | null, chatType: string) {
  return {
    args,
    dbUser: { telegram_id: 100, language: 'en' },
    send: mock(() => Promise.resolve()),
    chat: { type: chatType, id: -1001234 },
  };
}

describe('handleUnshare', () => {
  test('rejects in private chat', async () => {
    const { handleUnshare } = await import('../../../src/bot/commands/unshare');
    const ctx = makeCtx('1', 'private');
    await handleUnshare(ctx as never, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('groups');
  });

  test('shows usage for missing args', async () => {
    const { handleUnshare } = await import('../../../src/bot/commands/unshare');
    const ctx = makeCtx(null, 'supergroup');
    await handleUnshare(ctx as never, {} as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/unshare');
  });

  test('calls unshareEvent on valid args', async () => {
    const { handleUnshare } = await import('../../../src/bot/commands/unshare');
    const ctx = makeCtx('5', 'supergroup');
    const repo = { unshareEvent: mock(() => true) };
    await handleUnshare(ctx as never, repo as unknown as GroupChatRepository);
    expect(repo.unshareEvent).toHaveBeenCalledWith(-1001234, 5, 100);
  });

  test('shows error when event not found in group', async () => {
    const { handleUnshare } = await import('../../../src/bot/commands/unshare');
    const ctx = makeCtx('999', 'supergroup');
    const repo = { unshareEvent: mock(() => false) };
    await handleUnshare(ctx as never, repo as unknown as GroupChatRepository);
    expect(ctx.send).toHaveBeenCalled();
  });
});
