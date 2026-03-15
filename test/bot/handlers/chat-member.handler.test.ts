import { describe, expect, mock, test } from 'bun:test';

describe('createChatMemberHandler', () => {
  test('upserts group when bot added to group', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');

    const groupRepo = {
      upsertGroup: mock(() => {}),
      deactivate: mock(() => {}),
    };

    const handler = createChatMemberHandler(groupRepo as never);

    const ctx = {
      myChatMember: {
        chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
        from: { id: 100 },
        new_chat_member: { status: 'member' },
        old_chat_member: { status: 'left' },
      },
    };

    await handler(ctx);
    expect(groupRepo.upsertGroup).toHaveBeenCalledWith({
      chat_id: -1001234,
      title: 'Dev Team',
      added_by: 100,
    });
  });

  test('deactivates group when bot removed', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');

    const groupRepo = {
      upsertGroup: mock(() => {}),
      deactivate: mock(() => {}),
    };

    const handler = createChatMemberHandler(groupRepo as never);

    const ctx = {
      myChatMember: {
        chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
        from: { id: 100 },
        new_chat_member: { status: 'left' },
        old_chat_member: { status: 'member' },
      },
    };

    await handler(ctx);
    expect(groupRepo.deactivate).toHaveBeenCalledWith(-1001234);
  });

  test('handles kicked status as deactivation', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');

    const groupRepo = {
      upsertGroup: mock(() => {}),
      deactivate: mock(() => {}),
    };

    const handler = createChatMemberHandler(groupRepo as never);

    const ctx = {
      myChatMember: {
        chat: { id: -1001234, type: 'supergroup' },
        from: { id: 100 },
        new_chat_member: { status: 'kicked' },
        old_chat_member: { status: 'member' },
      },
    };

    await handler(ctx);
    expect(groupRepo.deactivate).toHaveBeenCalledWith(-1001234);
  });

  test('ignores private chats', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');

    const groupRepo = {
      upsertGroup: mock(() => {}),
      deactivate: mock(() => {}),
    };

    const handler = createChatMemberHandler(groupRepo as never);

    const ctx = {
      myChatMember: {
        chat: { id: 100, type: 'private' },
        from: { id: 100 },
        new_chat_member: { status: 'member' },
        old_chat_member: { status: 'left' },
      },
    };

    await handler(ctx);
    expect(groupRepo.upsertGroup).not.toHaveBeenCalled();
  });
});
