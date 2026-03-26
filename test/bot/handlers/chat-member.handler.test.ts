import { describe, expect, mock, test } from 'bun:test';
import { flushPromises } from '../../helpers/mock-context.ts';

function makeGroupRepo() {
  return {
    upsertGroup: mock(() => {}),
    deactivate: mock(() => {}),
  };
}

function makeDeps(lang: 'en' | 'ru' = 'en') {
  return {
    groupRepo: { ...makeGroupRepo(), setInviteLink: mock(() => {}) },
    sendMessage: mock(() => Promise.resolve()),
    getUserLanguage: mock(() => lang),
    exportInviteLink: mock(() => Promise.resolve(null as string | null)),
  };
}

type Ctx = {
  chat: { id: number; type: string; title?: string };
  from: { id: number };
  newChatMember: { status: string };
  oldChatMember: { status: string };
};

describe('createChatMemberHandler', () => {
  test('upserts group when bot added to group', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'left' },
    };
    await handler(ctx as never);

    expect(groupRepo.upsertGroup).toHaveBeenCalledWith({
      chat_id: -1001234,
      title: 'Dev Team',
      added_by: 100,
    });
  });

  test('sends welcome message in EN when bot added', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps('en');

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'left' },
    };
    await handler(ctx as never);

    expect(sendMessage).toHaveBeenCalledWith(-1001234, expect.stringContaining('/agenda'));
    const text = (sendMessage.mock.calls[0] as unknown[])[1] as string;
    expect(text).not.toContain('/agenda — события');
  });

  test('sends welcome message in RU when adder language is ru', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps('ru');

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'left' },
    };
    await handler(ctx as never);

    expect(sendMessage).toHaveBeenCalledWith(-1001234, expect.stringContaining('/agenda'));
    const text = (sendMessage.mock.calls[0] as unknown[])[1] as string;
    expect(text).toContain('Групповые');
  });

  test('sends welcome when restricted member joins (restricted → member)', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps('en');

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'restricted' },
    };
    await handler(ctx as never);

    expect(sendMessage).toHaveBeenCalledWith(-1001234, expect.stringContaining('/agenda'));
  });

  test('does not send welcome on re-join when already active', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'administrator' },
      oldChatMember: { status: 'member' },
    };
    await handler(ctx as never);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('deactivates group when bot removed', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'left' },
      oldChatMember: { status: 'member' },
    };
    await handler(ctx as never);

    expect(groupRepo.deactivate).toHaveBeenCalledWith(-1001234);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('handles kicked status as deactivation', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup' },
      from: { id: 100 },
      newChatMember: { status: 'kicked' },
      oldChatMember: { status: 'member' },
    };
    await handler(ctx as never);

    expect(groupRepo.deactivate).toHaveBeenCalledWith(-1001234);
  });

  test('ignores private chats', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: 100, type: 'private' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'left' },
    };
    await handler(ctx as never);

    expect(groupRepo.upsertGroup).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('welcome message contains admin hint', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps('en');

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'member' },
      oldChatMember: { status: 'left' },
    };
    await handler(ctx as never);

    const text = (sendMessage.mock.calls[0] as unknown[])[1] as string;
    expect(text).toContain('admin');
    expect(text).toContain('pin');
  });

  test('stores invite link when bot is promoted to admin', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const INVITE_LINK = 'https://t.me/+abc123';
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();
    exportInviteLink.mockResolvedValue(INVITE_LINK);

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'administrator' },
      oldChatMember: { status: 'member' },
    };
    await handler(ctx as never);

    await flushPromises();
    expect(exportInviteLink).toHaveBeenCalledWith(-1001234);
    expect(groupRepo.setInviteLink).toHaveBeenCalledWith(-1001234, INVITE_LINK);
  });

  test('does not store invite link if bot was already admin', async () => {
    const { createChatMemberHandler } = await import('../../../src/bot/handlers/chat-member.handler');
    const { groupRepo, sendMessage, getUserLanguage, exportInviteLink } = makeDeps();

    const handler = createChatMemberHandler(groupRepo as never, sendMessage, getUserLanguage, exportInviteLink);

    const ctx: Ctx = {
      chat: { id: -1001234, type: 'supergroup', title: 'Dev Team' },
      from: { id: 100 },
      newChatMember: { status: 'administrator' },
      oldChatMember: { status: 'administrator' },
    };
    await handler(ctx as never);

    await flushPromises();
    expect(exportInviteLink).not.toHaveBeenCalled();
  });
});
