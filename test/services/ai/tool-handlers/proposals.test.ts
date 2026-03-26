import { expect, mock, test } from 'bun:test';
import { handleProposeCalendarChange } from '../../../../src/services/ai/tool-handlers/proposals.ts';

function makeCtx(overrides: { [key: string]: unknown } = {}) {
  return {
    user: { telegram_id: 1, username: 'alice', first_name: 'Alice', language: 'ru', timezone: 'UTC' },
    chatId: -100123,
    groupTitle: 'Dev Team',
    messageText: '',
    isGroup: true,
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    userRepo: { findByTelegramId: () => null } as never,
    reminderRepo: {} as never,
    sendMessageToChat: mock(async () => ({ message_id: 1 })),
    botUsername: 'mybot',
    ...overrides,
  } as never;
}

test('propose: no calendarProposalRepo → error', async () => {
  const result = await handleProposeCalendarChange(makeCtx(), {
    target_telegram_id: 2,
    action: 'create',
    summary: 'test',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('not configured');
});

test('propose: target not in chat → PROPOSAL_TARGET_NOT_IN_CHAT', async () => {
  const result = await handleProposeCalendarChange(
    makeCtx({
      secretary: {
        calendarProposalRepo: {
          create: mock(() => ({ id: 1 })),
          setDmMessageId: mock(() => {}),
          setGroupMessageId: mock(() => {}),
        } as never,
        secretaryRepo: {} as never,
        secretaryForLine: undefined,
      },
      group: {
        checkGroupMembership: mock(async () => false),
        groupChatRepo: {} as never,
        groupMemberRepo: {} as never,
        groupMemberService: {} as never,
      },
    }),
    {
      target_telegram_id: 2,
      action: 'create',
      summary: 'add meeting',
      event: { title: 'Meeting', start_at: '2099-01-01T10:00:00Z', end_at: '2099-01-01T11:00:00Z', timezone: 'UTC' },
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain('PROPOSAL_TARGET_NOT_IN_CHAT');
});

test('propose: creates proposal and returns awaiting_confirmation', async () => {
  const mockCreate = mock(() => ({ id: 42, status: 'pending', target_id: 2 }));
  const result = await handleProposeCalendarChange(
    makeCtx({
      secretary: {
        calendarProposalRepo: {
          create: mockCreate,
          setDmMessageId: mock(() => {}),
          setGroupMessageId: mock(() => {}),
        } as never,
        secretaryRepo: {} as never,
        secretaryForLine: undefined,
      },
      group: {
        checkGroupMembership: mock(async () => true),
        groupChatRepo: {} as never,
        groupMemberRepo: {} as never,
        groupMemberService: {} as never,
      },
      sender: { sendMessage: mock(async () => ({ message_id: 5 })), sendAsUser: undefined } as never,
    }),
    {
      target_telegram_id: 2,
      action: 'create',
      summary: 'добавить Ретро',
      event: { title: 'Ретро', start_at: '2099-03-20T13:00:00Z', end_at: '2099-03-20T14:00:00Z', timezone: 'UTC' },
    },
  );
  expect(result.success).toBe(true);
  const output = JSON.parse(result.output as string) as { status: string };
  expect(output.status).toBe('awaiting_confirmation');
  expect(mockCreate).toHaveBeenCalled();
});
