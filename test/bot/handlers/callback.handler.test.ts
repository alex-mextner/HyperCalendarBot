import { describe, expect, mock, test } from 'bun:test';
import {
  createCallbackHandler,
  handleProposalAccept,
  handleProposalDecline,
  handleSecretaryAccept,
  handleSecretaryDecline,
  parseAiBtnPayload,
} from '../../../src/bot/handlers/callback.handler.ts';

function makeCtx(data: string, overrides: Record<string, unknown> = {}) {
  return {
    data,
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    message: { chat: { id: 100 }, send: mock(() => Promise.resolve()) },
    chat: { id: 100 },
    ...overrides,
  };
}

function makeHandler(overrides: Record<string, unknown> = {}) {
  const eventService = {
    getEvent: mock(() => ({
      id: 1,
      title: 'Test',
      start_at: '2026-03-17T10:00:00Z',
      end_at: null,
      all_day: 0,
      description: null,
      location: null,
      category: null,
      recurrence_rule: null,
    })),
    getEventsForDay: mock(() => [
      {
        event: { id: 1, title: 'Test', start_at: '2026-03-17T10:00:00Z', recurrence_rule: null },
        occurrence_start: '2026-03-17T10:00:00Z',
        occurrence_end: '2026-03-17T11:00:00Z',
      },
    ]),
    getEventsForWeek: mock(() => []),
    ...overrides,
  };
  return createCallbackHandler(eventService as never, {} as never, {} as never, {} as never);
}

describe('createCallbackHandler', () => {
  test('handles event view callback', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('ev:1');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('handles event view cancel', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('ev:cancel');
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalled();
    const text = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toBe('❌ Закрыто');
  });

  test('handles unknown action gracefully', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('unknown_action:123');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('handles empty data', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('', { data: undefined });
    await handler(ctx as never);
    // Should return without error
  });

  test('ai_btn triggers callback', async () => {
    const onAiButtonClick = mock(() => Promise.resolve());
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, { onAiButtonClick });
    const ctx = makeCtx('ai_btn:Да');
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith('✅ Да');
    expect(onAiButtonClick).toHaveBeenCalledWith(100, 100, 'Да');
  });

  test('ai_btn with userId restriction allows matching user', async () => {
    const onAiButtonClick = mock(() => Promise.resolve());
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, { onAiButtonClick });
    // User 100 clicks on button restricted to user 100
    const ctx = makeCtx('ai_btn:100:Да', { from: { id: 100 } });
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith('✅ Да');
  });

  test('ai_btn with userId restriction blocks wrong user', async () => {
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never);
    // User 200 clicks on button restricted to user 100
    const ctx = makeCtx('ai_btn:100:Нет', { from: { id: 200 } });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Не твой вопрос', show_alert: false });
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('share_evt:today shows events for today', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('share_evt:today');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('share_evt:evt shows event detail', async () => {
    const handler = makeHandler();
    const ctx = makeCtx('share_evt:evt:1');
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });
});

const pendingRecord = {
  id: 5,
  owner_id: 10,
  secretary_id: 20,
  permission: 'write' as const,
  status: 'pending' as const,
  dm_message_id: 777,
  created_at: '',
  updated_at: '',
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    secretaryRepo: {
      findById: mock(() => pendingRecord),
      updateStatus: mock(() => true),
      setDmMessageId: mock(() => {}),
    },
    userRepo: { findByTelegramId: mock(() => ({ first_name: 'Alice', username: 'alice', telegram_id: 10 })) },
    sendMessage: mock(async () => {}),
    editMessage: mock(async () => {}),
    ...overrides,
  };
}

test('sec:accept: sets status active and notifies owner', async () => {
  const deps = makeDeps();
  await handleSecretaryAccept(5, pendingRecord.secretary_id, deps as never);

  expect(deps.secretaryRepo.updateStatus).toHaveBeenCalledWith(5, 'active');
  expect(deps.sendMessage).toHaveBeenCalledWith(pendingRecord.owner_id, expect.stringContaining('принял'));
});

test('sec:accept: edits invitation message at secretary', async () => {
  const deps = makeDeps();
  await handleSecretaryAccept(5, pendingRecord.secretary_id, deps as never);

  expect(deps.editMessage).toHaveBeenCalledWith(
    pendingRecord.secretary_id,
    pendingRecord.dm_message_id,
    expect.stringContaining('Принято'),
  );
});

test('sec:accept: no-op if record not found', async () => {
  const deps = makeDeps({
    secretaryRepo: { findById: mock(() => null), updateStatus: mock(() => true) },
  });
  await expect(handleSecretaryAccept(5, pendingRecord.secretary_id, deps as never)).resolves.toBeUndefined();
  expect(deps.secretaryRepo.updateStatus).not.toHaveBeenCalled();
});

test('sec:accept: no-op if caller is not the secretary', async () => {
  const deps = makeDeps();
  await handleSecretaryAccept(5, 999, deps as never);

  expect(deps.secretaryRepo.updateStatus).not.toHaveBeenCalled();
});

test('sec:accept: no-op if record is not pending', async () => {
  const deps = makeDeps({
    secretaryRepo: {
      findById: mock(() => ({ ...pendingRecord, status: 'active' })),
      updateStatus: mock(() => true),
    },
  });
  await handleSecretaryAccept(5, pendingRecord.secretary_id, deps as never);

  expect(deps.secretaryRepo.updateStatus).not.toHaveBeenCalled();
});

test('sec:decline: sets status declined and notifies owner', async () => {
  const deps = makeDeps();
  await handleSecretaryDecline(5, pendingRecord.secretary_id, deps as never);

  expect(deps.secretaryRepo.updateStatus).toHaveBeenCalledWith(5, 'declined');
  expect(deps.sendMessage).toHaveBeenCalledWith(pendingRecord.owner_id, expect.stringContaining('отклонил'));
});

test('sec:decline: no-op if caller is not the secretary', async () => {
  const deps = makeDeps();
  await handleSecretaryDecline(5, 999, deps as never);

  expect(deps.secretaryRepo.updateStatus).not.toHaveBeenCalled();
});

const basePendingProposal = {
  id: 10,
  proposer_id: 1,
  target_id: 2,
  status: 'pending' as const,
  action: 'create' as const,
  payload: JSON.stringify({
    action: 'create',
    event: { title: 'Ретро', start_at: '2099-03-20T15:00:00Z', end_at: '2099-03-20T16:00:00Z' },
  }),
  summary: 'добавить Ретро',
  group_chat_id: -100,
  group_message_id: 555,
  dm_message_id: 777,
  expires_at: '2099-12-31T00:00:00Z',
  group_chat_title: 'Dev Team',
  created_at: '',
  updated_at: '',
};

function makeProposalDeps(overrides: Record<string, unknown> = {}) {
  return {
    proposalRepo: {
      findById: mock(() => basePendingProposal),
      updateStatus: mock(() => true),
    },
    eventService: {
      createEvent: mock(() => ({ id: 99, title: 'Ретро' })),
      updateEvent: mock(() => ({ id: 1 })),
      deleteEvent: mock(() => true),
    },
    userRepo: { findByTelegramId: mock(() => ({ first_name: 'Alice', username: 'alice', telegram_id: 1 })) },
    editMessage: mock(async () => {}),
    sendMessage: mock(async () => {}),
    ...overrides,
  };
}

test('prop:accept: executes create payload as target_id=2, edits DM and group', async () => {
  const deps = makeProposalDeps();
  await handleProposalAccept(10, basePendingProposal.target_id, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'accepted');
  expect(deps.eventService.createEvent).toHaveBeenCalledWith(2, expect.objectContaining({ title: 'Ретро' }));
  expect(deps.editMessage).toHaveBeenCalledTimes(2); // DM + group
});

test('prop:accept: event gone → notifies both parties, does not crash', async () => {
  const deps = makeProposalDeps({
    eventService: { createEvent: mock(() => null) },
  });
  await handleProposalAccept(10, basePendingProposal.target_id, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'expired');
  expect(deps.sendMessage).toHaveBeenCalledTimes(2); // proposer + target notified
});

test('prop:accept: no-op if status != pending, edits DM only', async () => {
  const deps = makeProposalDeps({
    proposalRepo: {
      findById: mock(() => ({ ...basePendingProposal, status: 'expired' })),
      updateStatus: mock(() => true),
    },
  });
  await handleProposalAccept(10, basePendingProposal.target_id, deps as never);

  expect(deps.eventService.createEvent).not.toHaveBeenCalled();
  expect(deps.editMessage).toHaveBeenCalledWith(
    basePendingProposal.target_id,
    basePendingProposal.dm_message_id,
    expect.stringContaining('истекло'),
  );
});

test('prop:accept: no-op if caller is not the target', async () => {
  const deps = makeProposalDeps();
  await handleProposalAccept(10, 999, deps as never);

  expect(deps.proposalRepo.updateStatus).not.toHaveBeenCalled();
  expect(deps.eventService.createEvent).not.toHaveBeenCalled();
});

test('prop:decline: sets declined, edits DM + group, notifies proposer', async () => {
  const deps = makeProposalDeps();
  await handleProposalDecline(10, basePendingProposal.target_id, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'declined');
  expect(deps.editMessage).toHaveBeenCalledTimes(2);
  expect(deps.sendMessage).toHaveBeenCalledWith(basePendingProposal.proposer_id, expect.stringContaining('отклонил'));
});

test('prop:decline: no-op if caller is not the target', async () => {
  const deps = makeProposalDeps();
  await handleProposalDecline(10, 999, deps as never);

  expect(deps.proposalRepo.updateStatus).not.toHaveBeenCalled();
});

describe('parseAiBtnPayload', () => {
  test('private chat — plain text payload', () => {
    expect(parseAiBtnPayload('Да')).toEqual({ answerText: 'Да' });
  });

  test('group chat — userId:text payload', () => {
    expect(parseAiBtnPayload('123:Нет')).toEqual({ answerText: 'Нет', restrictedToUserId: 123 });
  });

  test('non-numeric first segment treated as plain text', () => {
    expect(parseAiBtnPayload('text:with:colons')).toEqual({ answerText: 'text:with:colons' });
  });

  test('non-numeric prefix with colons treated as plain text', () => {
    expect(parseAiBtnPayload('yes:please')).toEqual({ answerText: 'yes:please' });
  });
});
