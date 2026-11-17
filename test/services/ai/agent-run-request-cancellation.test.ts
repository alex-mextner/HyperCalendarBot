import { describe, expect, mock, spyOn, test } from 'bun:test';
import { t } from '../../../src/config/constants.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import { encryptBlob } from '../../../src/services/crypto/session-crypto.ts';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';
import { createAgentRunFixture, isValidatorCall, setupInvitations, USER_ID } from './agent-run-helpers.ts';

const RECIPIENT_ID = 789;
const REQUEST_TIMEOUT_MS = 1234;
const MASTER_KEY = Buffer.alloc(32, 0x63);

type BatchCall = { id: string; name: string; input: { [key: string]: unknown } };

function oneToolBatch(calls: BatchCall[]) {
  let modelCalls = 0;
  const impl = async (options: StreamRoundOptions, callbacks: StreamCallbacks = {}): Promise<StreamRoundResult> => {
    if (isValidatorCall(options)) {
      return {
        text: 'APPROVE',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'APPROVE' },
        providerUsed: 'synthetic-validator',
      };
    }
    modelCalls++;
    if (modelCalls !== 1) throw new Error('Cancelled request dispatched another model round');
    for (const call of calls) callbacks.onToolCallStart?.(call.name);
    return {
      text: '',
      toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.input) })),
      finishReason: 'tool_calls',
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      },
      providerUsed: 'synthetic',
    };
  };
  return { impl, modelCalls: () => modelCalls };
}

/** Supply the real agent's request deadline without wall-clock races or shutdown semantics. */
function controlledDeadline() {
  const controller = new AbortController();
  const reason = new DOMException('Synthetic request deadline', 'TimeoutError');
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) =>
    milliseconds === REQUEST_TIMEOUT_MS ? controller.signal : realTimeout(milliseconds),
  );
  return { controller, reason, restore: () => timeout.mockRestore() };
}

describe('CalendarBotAgent request cancellation at tool boundaries', () => {
  test('cancellation during the invitation progress flush prevents numeric invitation dispatch', async () => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    const deadline = controlledDeadline();
    const event = setupInvitations(db, ctx);
    ctx.userRepo.create({ telegram_id: RECIPIENT_ID, timezone: 'UTC', language: 'en' });
    ctx.messageText = 'Invite 789 to the event.';
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const createInvitation = spyOn(ctx.sharing!.invitationService, 'sendInvitation');
    const deliver = mock(async () => ({ message_id: 55 }));
    sender.sendInvitation = deliver;
    let invitationFlushReached = false;
    sender.editMessageText = mock(async (_chatId, _messageId, text) => {
      if (!invitationFlushReached && text.includes('📨 Invitation')) {
        invitationFlushReached = true;
        expect(ctx.requestSignal?.aborted).toBe(false);
        deadline.controller.abort(deadline.reason);
      }
    });
    const script = oneToolBatch([
      { id: 'send-after-flush', name: 'send_invitation', input: { event_id: event.id, invitee_id: RECIPIENT_ID } },
    ]);

    try {
      await new CalendarBotAgent(config, sender, {
        streamImpl: script.impl,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      }).run(ctx);

      expect(invitationFlushReached).toBe(true);
      expect(ctx.requestSignal?.aborted).toBe(true);
      expect(createInvitation).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(script.modelCalls()).toBe(1);
    } finally {
      createInvitation.mockRestore();
      deadline.restore();
      db.close();
    }
  });

  test('a cancelled active personal lookup stops later writes in its batch and retains the earlier read', async () => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    const deadline = controlledDeadline();
    const event = setupInvitations(db, ctx);
    ctx.userRepo.create({ telegram_id: RECIPIENT_ID, timezone: 'UTC', language: 'en' });
    ctx.contactRepo = new ContactRepository(db);
    ctx.contactRepo.add(USER_ID, 'Synthetic saved contact');
    ctx.messageText = 'List my contacts, find @synthetic_lookup, then invite 789 to the event.';
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const sessions = new TelegramSessionRepository(db);
    const encrypted = encryptBlob(Buffer.from('synthetic lookup credential'), MASTER_KEY);
    sessions.upsert(USER_ID, encrypted, '+***00', 'synthetic-owner');
    ctx.telegramSessionRepo = sessions;
    ctx.telegramMasterKey = MASTER_KEY;
    const createInvitation = spyOn(ctx.sharing!.invitationService, 'sendInvitation');
    const deliver = mock(async () => ({ message_id: 55 }));
    const reconnect = mock(async () => ({ message_id: 56 }));
    sender.sendInvitation = deliver;
    sender.sendMessageWithKeyboard = reconnect;
    const createTemp = spyOn(SessionBridge, 'createTempSessionFile').mockResolvedValue('/synthetic/lookup.session');
    const cleanup = spyOn(SessionBridge, 'cleanupTempFile').mockResolvedValue(undefined);
    let lookupStarted = false;
    const lookup = spyOn(SessionBridge, 'resolveUsernameAsUser').mockImplementation(
      async (_path, userId, username, signal) => {
        lookupStarted = true;
        expect(userId).toBe(USER_ID);
        expect(username).toBe('synthetic_lookup');
        expect(signal).toBe(ctx.requestSignal);
        expect(signal?.aborted).toBe(false);
        deadline.controller.abort(deadline.reason);
        throw deadline.reason;
      },
    );
    const script = oneToolBatch([
      { id: 'completed-read', name: 'get_contacts', input: {} },
      { id: 'active-lookup', name: 'find_user', input: { username: 'synthetic_lookup' } },
      { id: 'send-after-lookup', name: 'send_invitation', input: { event_id: event.id, invitee_id: RECIPIENT_ID } },
    ]);

    try {
      const result = await new CalendarBotAgent(config, sender, {
        streamImpl: script.impl,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      }).run(ctx);

      expect(lookupStarted).toBe(true);
      expect(cleanup).toHaveBeenCalledWith('/synthetic/lookup.session');
      expect(createInvitation).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
      expect(sessions.getActive(USER_ID)).not.toBeNull();
      expect(result.toolCalls[0]?.name).toBe('get_contacts');
      expect(result.toolResults[0]).toMatchObject({ success: true });
      expect(result.toolResults[0]?.output).toContain('Synthetic saved contact');
      const readHistory = ctx.chatHistory.getRecent(USER_ID, 50).filter((row) => row.role === 'tool');
      expect(
        readHistory.some(
          (row) => row.content.includes('completed-read') && row.content.includes('Synthetic saved contact'),
        ),
      ).toBe(true);
      expect(script.modelCalls()).toBe(1);
      ctx.chatHistory.save(USER_ID, 'user', 'What was completed?');
      const nextTurn = await new CalendarBotAgent(config, sender).buildMessages(
        { ...ctx, messageText: 'What was completed?', requestSignal: undefined },
        ctx.chatHistory.getRecent(USER_ID, 50),
      );
      expect(
        nextTurn.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === 'completed-read' &&
            String(message.content).includes('Synthetic saved contact'),
        ),
      ).toBe(true);
    } finally {
      lookup.mockRestore();
      cleanup.mockRestore();
      createTemp.mockRestore();
      createInvitation.mockRestore();
      deadline.restore();
      db.close();
    }
  });

  test('cancellation after recipient resolution retains proven not-applied evidence before insertion', async () => {
    const { db, ctx, sender } = createAgentRunFixture();
    const controller = new AbortController();
    const event = setupInvitations(db, ctx);
    ctx.userRepo.create({ telegram_id: RECIPIENT_ID, timezone: 'UTC', language: 'en' });
    ctx.messageText = 'Invite 789 to the event.';
    ctx.requestSignal = controller.signal;
    ctx.sender = sender;
    const realGetEvent = ctx.eventService.getEvent.bind(ctx.eventService);
    let scopeReads = 0;
    const readEvent = spyOn(ctx.eventService, 'getEvent').mockImplementation((...args) => {
      const result = realGetEvent(...args);
      if (++scopeReads === 2) controller.abort(new DOMException('Synthetic deadline after lookup', 'TimeoutError'));
      return result;
    });
    const createInvitation = spyOn(ctx.sharing!.invitationService, 'sendInvitation');
    const deliver = mock(async () => ({ message_id: 55 }));
    sender.sendInvitation = deliver;

    try {
      const result = await executeTool(ctx, 'send_invitation', { event_id: event.id, invitee_id: RECIPIENT_ID });
      expect(scopeReads).toBe(2);
      expect(controller.signal.aborted).toBe(true);
      expect(createInvitation).not.toHaveBeenCalled();
      expect(ctx.sharing!.invitationRepo.getByEvent(event.id)).toHaveLength(0);
      expect(deliver).not.toHaveBeenCalled();
      expect(result).toMatchObject({ success: false, mutationState: 'not_applied', disposition: 'failed' });
    } finally {
      createInvitation.mockRestore();
      readEvent.mockRestore();
      db.close();
    }
  });

  test('cancellation after real insertion retains the created invitation receipt and prevents delivery or replay', async () => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    const deadline = controlledDeadline();
    const event = setupInvitations(db, ctx);
    ctx.userRepo.create({ telegram_id: RECIPIENT_ID, timezone: 'UTC', language: 'en' });
    ctx.contactRepo = new ContactRepository(db);
    ctx.messageText = 'Invite 789 to the event, then save Cancelled later contact.';
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const deliver = mock(async () => ({ message_id: 55 }));
    const reconnect = mock(async () => ({ message_id: 56 }));
    sender.sendInvitation = deliver;
    sender.sendMessageWithKeyboard = reconnect;
    const service = ctx.sharing!.invitationService;
    const realSend = service.sendInvitation.bind(service);
    let insertedId: number | undefined;
    const createInvitation = spyOn(service, 'sendInvitation').mockImplementation((...args) => {
      const result = realSend(...args);
      if (result.success) {
        insertedId = result.invitation!.id;
        deadline.controller.abort(deadline.reason);
      }
      return result;
    });
    const script = oneToolBatch([
      { id: 'created-before-cancel', name: 'send_invitation', input: { event_id: event.id, invitee_id: RECIPIENT_ID } },
      { id: 'write-after-cancel', name: 'add_contact', input: { name: 'Cancelled later contact' } },
    ]);

    try {
      const result = await new CalendarBotAgent(config, sender, {
        streamImpl: script.impl,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      }).run(ctx);

      const invitations = ctx.sharing!.invitationRepo.getByEvent(event.id);
      expect(invitations).toHaveLength(1);
      expect(insertedId).toBe(invitations[0]!.id);
      expect(createInvitation).toHaveBeenCalledTimes(1);
      const createdEvidence = t('en').aiTools.sharing.invitationCreated(invitations[0]!.id, event.id, RECIPIENT_ID);
      expect(result.toolResults[0]).toMatchObject({ success: true });
      expect(result.toolResults[0]?.output).toContain(createdEvidence);
      expect(result.toolResults[0]?.output).toContain('direct delivery unconfirmed');
      const toolHistory = ctx.chatHistory.getRecent(USER_ID, 50).filter((row) => row.role === 'tool');
      expect(
        toolHistory.some(
          (row) => row.content.includes('created-before-cancel') && row.content.includes(createdEvidence),
        ),
      ).toBe(true);
      expect(ctx.contactRepo.findByNameStrict(USER_ID, 'Cancelled later contact')).toBeNull();
      expect(result.toolCalls.some((call) => call.name === 'add_contact')).toBe(false);
      expect(deliver).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
      expect(script.modelCalls()).toBe(1);
      expect(result.responseText).toContain('unconfirmed');
      expect(result.responseText).toMatch(/invitation[\s\S]*created/i);
      expect(result.responseText).not.toContain('nothing was changed');
      expect(result.responseText).not.toMatch(/\b(?:was delivered|was sent)\b/i);
      ctx.chatHistory.save(USER_ID, 'user', 'What was completed?');
      const nextTurn = await new CalendarBotAgent(config, sender).buildMessages(
        { ...ctx, messageText: 'What was completed?', requestSignal: undefined },
        ctx.chatHistory.getRecent(USER_ID, 50),
      );
      expect(
        nextTurn.messages.some(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === 'created-before-cancel' &&
            String(message.content).includes(createdEvidence),
        ),
      ).toBe(true);
    } finally {
      createInvitation.mockRestore();
      deadline.restore();
      db.close();
    }
  });
});
