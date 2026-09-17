import { describe, expect, mock, test } from 'bun:test';
import {
  createCallbackHandler,
  handleProposalAccept,
  handleProposalDecline,
  handleSecretaryAccept,
  handleSecretaryDecline,
  type ProposalDeps,
  parseAiBtnPayload,
  type SecretaryDeps,
} from '../../../src/bot/handlers/callback.handler.ts';

interface MockCallbackCtxOverrides {
  from?: { id: number };
  data?: undefined;
}

function makeCtx(data: string, overrides: MockCallbackCtxOverrides = {}) {
  return {
    data,
    chatId: 100,
    dbUser: { telegram_id: 100, language: 'ru', timezone: 'UTC' },
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    message: { id: 1, text: '', chat: { id: 100, type: 'private' }, send: mock(() => Promise.resolve()) },
    from: { id: 100 },
    ...overrides,
  };
}

function makeHandler(overrides: { [key: string]: unknown } = {}) {
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

  test('ai_btn preserves a private time answer containing a colon', async () => {
    const onAiButtonClick = mock(() => Promise.resolve());
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, { onAiButtonClick });
    const ctx = makeCtx('ai_btn:19:00');
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith('✅ 19:00');
    expect(onAiButtonClick).toHaveBeenCalledWith(100, 100, '19:00');
  });

  test('ai_btn with userId restriction allows matching user', async () => {
    const onAiButtonClick = mock(() => Promise.resolve());
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, { onAiButtonClick });
    // User 100 clicks on button restricted to user 100
    const ctx = makeCtx('ai_btn:100:Да', { from: { id: 100 } });
    ctx.message.chat.type = 'group';
    await handler(ctx as never);
    expect(ctx.editText).toHaveBeenCalledWith('✅ Да');
  });

  test('ai_btn with userId restriction blocks wrong user', async () => {
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never);
    // User 200 clicks on button restricted to user 100
    const ctx = makeCtx('ai_btn:100:Нет', { from: { id: 200 } });
    ctx.message.chat.type = 'group';
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

// ── editProposal:accept|reject end-to-end callback wiring ─────────
// Regression coverage: editProposalDeps was never injected in bot/index.ts
// for an unknown period — the button clicks from `sendEditProposal` reached
// the dispatch table but returned early because of the missing dep. These
// tests lock the happy paths so a future refactor can't silently re-break it.

function makeEditProposalDeps(
  overrides: {
    proposalStatus?: 'pending' | 'accepted' | 'rejected';
    proposalEventId?: number;
    ownerId?: number;
    updatedEvent?: { id: number; title: string } | null;
    proposerLang?: 'en' | 'ru';
  } = {},
) {
  const {
    proposalStatus = 'pending',
    proposalEventId = 42,
    ownerId = 100,
    updatedEvent = { id: 42, title: 'Team meeting' },
    proposerLang = 'en',
  } = overrides;

  const updateStatus = mock(() => true);
  const sendMessage = mock(async () => {});

  const eventService = {
    getEvent: mock(() => ({ id: proposalEventId, title: 'Team meeting' })),
    getEventOwnerId: mock(() => ownerId),
    getEventIncludingSoftDeleted: mock(() => ({ id: proposalEventId, title: 'Team meeting' })),
    updateEvent: mock(() => updatedEvent),
    getEventsForDay: mock(() => []),
    getEventsForWeek: mock(() => []),
  };

  const handler = createCallbackHandler(eventService as never, {} as never, {} as never, {} as never, {
    editProposalDeps: {
      editProposalRepo: {
        findById: mock(() => ({
          id: 7,
          event_id: proposalEventId,
          proposer_id: 200,
          changes: JSON.stringify({ title: 'New title' }),
          status: proposalStatus,
          reason: null,
          created_at: '',
        })),
        updateStatus,
      } as never,
      sendMessage,
    },
    userRepo: {
      findByTelegramId: mock(() => ({ telegram_id: 200, language: proposerLang })),
    } as never,
  });

  return { handler, eventService, updateStatus, sendMessage };
}

describe('editProposal callback wiring', () => {
  test('owner Accept: updates status, updates event, notifies proposer with title', async () => {
    const { handler, eventService, updateStatus, sendMessage } = makeEditProposalDeps();
    const ctx = makeCtx('epr:accept:7', { from: { id: 100 } });
    await handler(ctx as never);

    expect(updateStatus).toHaveBeenCalledWith(7, 'accepted');
    expect(eventService.updateEvent).toHaveBeenCalledWith(
      42,
      100,
      { title: 'New title' },
      {
        source: 'proposal_accept',
        skipProposalExpiry: true,
        excludeUserIds: [200],
      },
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(chatId).toBe(200);
    expect(text).toContain('Team meeting');
    expect(text).toContain('accepted');
  });

  test('owner Reject: updates status, notifies proposer with title', async () => {
    const { handler, updateStatus, sendMessage } = makeEditProposalDeps();
    const ctx = makeCtx('epr:reject:7', { from: { id: 100 } });
    await handler(ctx as never);

    expect(updateStatus).toHaveBeenCalledWith(7, 'rejected');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(chatId).toBe(200);
    expect(text).toContain('Team meeting');
    expect(text).toContain('rejected');
  });

  test('Reject still notifies with title even after event is soft-deleted', async () => {
    // Simulates the flow that motivated the whole soft-delete refactor:
    // owner has removed the event before processing the proposal. The
    // notification must still carry the event title via
    // getEventIncludingSoftDeleted.
    const { handler, updateStatus, sendMessage } = makeEditProposalDeps({ updatedEvent: null });
    const ctx = makeCtx('epr:reject:7', { from: { id: 100 } });
    await handler(ctx as never);
    expect(updateStatus).toHaveBeenCalledWith(7, 'rejected');
    const [, text] = sendMessage.mock.calls[0] as unknown as [number, string];
    expect(text).toContain('Team meeting');
  });

  test('non-owner click is rejected with notAuthorized and no side effects', async () => {
    const { handler, eventService, updateStatus, sendMessage } = makeEditProposalDeps({ ownerId: 100 });
    // Different clicker id — not the owner.
    const ctx = makeCtx('epr:accept:7', { from: { id: 999 } });
    (ctx as { dbUser: { telegram_id: number } }).dbUser = {
      telegram_id: 999,
      language: 'en',
      timezone: 'UTC',
    } as never;
    await handler(ctx as never);

    expect(updateStatus).not.toHaveBeenCalled();
    expect(eventService.updateEvent).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Not authorized' });
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

function makeDeps(overrides: Partial<SecretaryDeps> & { [key: string]: unknown } = {}) {
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
      findById: mock(() => ({ ...pendingRecord, status: 'active' as const })),
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
    event: {
      title: 'Ретро',
      start_at: '2099-03-20T15:00:00Z',
      end_at: '2099-03-20T16:00:00Z',
      timezone: 'UTC',
    },
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

function makeProposalDeps(overrides: Partial<ProposalDeps> & { [key: string]: unknown } = {}) {
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
    eventService: { createEvent: mock(() => null), updateEvent: mock(() => null), deleteEvent: mock(() => true) },
  });
  await handleProposalAccept(10, basePendingProposal.target_id, deps as never);

  expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'expired');
  expect(deps.sendMessage).toHaveBeenCalledTimes(2); // proposer + target notified
});

test('prop:accept: no-op if status != pending, edits DM only', async () => {
  const deps = makeProposalDeps({
    proposalRepo: {
      findById: mock(() => ({ ...basePendingProposal, status: 'expired' as const })),
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

  test('private chat — a time with colon is not mistaken for a user restriction', () => {
    expect(parseAiBtnPayload('19:00')).toEqual({ answerText: '19:00' });
  });

  test('group chat — userId:text payload', () => {
    expect(parseAiBtnPayload('123:Нет', true)).toEqual({ answerText: 'Нет', restrictedToUserId: 123 });
  });

  test('group chat — answer text may itself contain a colon', () => {
    expect(parseAiBtnPayload('123:19:00', true)).toEqual({ answerText: '19:00', restrictedToUserId: 123 });
  });

  test('non-numeric first segment treated as plain text', () => {
    expect(parseAiBtnPayload('text:with:colons')).toEqual({ answerText: 'text:with:colons' });
  });

  test('non-numeric prefix with colons treated as plain text', () => {
    expect(parseAiBtnPayload('yes:please')).toEqual({ answerText: 'yes:please' });
  });
});

describe('geo timezone confirm/dismiss callbacks', () => {
  test('GEO_TZ_CONFIRM updates user timezone and edits message', async () => {
    const update = mock(() => ({ telegram_id: 100, timezone: 'Europe/Moscow' }));
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      userRepo: { update, findByTelegramId: mock(() => null) } as never,
    });
    const ctx = makeCtx('gtzc:Europe/Moscow');
    await handler(ctx as never);

    expect(update).toHaveBeenCalledTimes(1);
    const [id, data] = update.mock.calls[0] as unknown as [number, { timezone: string; country_code?: string }];
    expect(id).toBe(100);
    expect(data.timezone).toBe('Europe/Moscow');
    expect(data.country_code).toBe('RU');
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    const editedText = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editedText).toContain('Europe/Moscow');
  });

  test('GEO_TZ_DISMISS keeps timezone and edits message', async () => {
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never);
    const ctx = makeCtx('gtzd');
    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    const editedText = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(editedText).toContain('не изменён');
  });

  test('GEO_TZ_CONFIRM shows error when userRepo is absent', async () => {
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never);
    const ctx = makeCtx('gtzc:Europe/Moscow');
    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    const answerArg = ctx.answer.mock.calls[0] as unknown[];
    expect(answerArg[0]).toEqual({ text: 'Ошибка' });
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('GEO_TZ_CONFIRM rejects invalid timezone payload', async () => {
    const update = mock(() => null);
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      userRepo: { update, findByTelegramId: mock(() => null) } as never,
    });
    const ctx = makeCtx('gtzc:Invalid/Timezone_Zone');
    await handler(ctx as never);

    expect(update).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});

describe('group settings timezone callback', () => {
  test('gst:select stores pending input and sends city prompt', async () => {
    const { pendingGroupTzInput } = await import('../../../src/bot/commands/settings.ts');
    const groupRepo = { findByChatId: mock(() => null) };
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      groupRepo: groupRepo as never,
    });
    const send = mock(() => Promise.resolve());
    const ctx = {
      ...makeCtx('gst:select'),
      chatId: -200,
      send,
    };
    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const prompt = send.mock.calls[0] as unknown as [string];
    expect(prompt[0]).toContain('Введите название города');
    const pending = pendingGroupTzInput.get(100);
    expect(pending).toBeDefined();
    expect(pending?.chatId).toBe(-200);
    pendingGroupTzInput.delete(100);
  });

  test('gst:select returns early when chatId is missing', async () => {
    const groupRepo = { findByChatId: mock(() => null) };
    const handler = createCallbackHandler({} as never, {} as never, {} as never, {} as never, {
      groupRepo: groupRepo as never,
    });
    const send = mock(() => Promise.resolve());
    const ctx = {
      ...makeCtx('gst:select'),
      chatId: undefined,
      send,
    };
    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
