import { describe, expect, mock, spyOn, test } from 'bun:test';
import { continueWithAgent } from '../../../src/bot/handlers/agent-continuation.ts';
import { buildPickerResultMessage, deliverPickerInvitations } from '../../../src/bot/handlers/picker-invitation.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { TelegramSessionRepository } from '../../../src/database/repositories/telegram-session.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import type { InvitationDeliveryReceipt } from '../../../src/services/ai/invitation-receipts.ts';
import { shouldValidateResponse, validateResponse } from '../../../src/services/ai/response-validator.ts';
import type { aiStreamRound } from '../../../src/services/ai/streaming.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import {
  createAgentRunFixture,
  isValidatorCall,
  makeStreamImpl,
  type ScriptedRound,
  setupInvitations,
  shownEdits,
  USER_ID,
} from './agent-run-helpers.ts';

const CLAIM = 'Alice received the invitation.';
const CORRECTION =
  'Direct delivery is unconfirmed. Check whether Alice received the invitation before forwarding a link.';
const OUTCOMES: InvitationDeliveryReceipt['outcome'][] = [
  'delivered',
  'manual_forward',
  'failed',
  'unconfirmed',
  'not_configured',
];

function needsValidation(invitationDeliveryReceipts: readonly InvitationDeliveryReceipt[]) {
  return shouldValidateResponse({
    userMessage: 'Save Alice to my contacts and explain the invitation result.',
    timezone: 'UTC',
    tools: [{ name: 'add_contact', input: { name: 'Alice' }, success: true }],
    response: CLAIM,
    invitationDeliveryReceipts,
  });
}

describe('picker receipts survive unrelated tools', () => {
  test.each(OUTCOMES)('%s receipt requires validation after add_contact', (outcome) => {
    expect(needsValidation([{ eventId: 1, recipientId: 201, outcome }])).toBe(true);
  });

  test('an empty receipt list preserves the ordinary write fast path', () => {
    expect(needsValidation([])).toBe(false);
  });

  test('grounded schedule facts cannot bypass the separate delivery receipt', async () => {
    let validatorCalls = 0;
    const result = await validateResponse(
      {
        userMessage: 'What about lunch and the invitation?',
        timezone: 'UTC',
        userProfile: '',
        tools: [
          {
            name: 'get_events',
            input: { start_date: '2030-01-01', end_date: '2030-01-01' },
            success: true,
            output: 'Lunch at 12:00',
            data: [{ id: 1, title: 'Lunch', date: '2030-01-01', time: '12:00', all_day: false }],
          },
        ],
        response: `Lunch is at 12:00. ${CLAIM}`,
        invitationDeliveryReceipts: [{ eventId: 1, recipientId: 201, outcome: 'manual_forward' }],
      },
      async (options) => {
        validatorCalls++;
        expect(String(options.messages[0]?.content)).toContain('direct delivery remains unconfirmed');
        return {
          text: 'REJECT: the invitation receipt does not confirm direct delivery',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: unconfirmed delivery' },
          providerUsed: 'synthetic-validator',
        };
      },
      { now: new Date('2030-01-01T09:00:00Z') },
    );
    expect(validatorCalls).toBe(1);
    expect(result.verdict).toBe('rejected');
  });

  test.each([
    'manual_forward',
    'unconfirmed',
  ] as const)('the final handler checks %s evidence after refusing a continuation alias write', async (outcome) => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    ctx.contactRepo = new ContactRepository(db);
    ctx.contactRepo.upsert(USER_ID, 'Alice', undefined, 201);
    ctx.messageText = 'Save Alice as Ally and explain the invitation result.';
    ctx.invitationDeliveryReceipts = [{ eventId: 1, recipientId: 201, outcome }];
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'save-alice', name: 'add_contact', input: { name: 'Alice', preferred_name: 'Ally' } },
      { kind: 'text', text: CLAIM },
      { kind: 'text', text: CORRECTION },
    ]);
    const validatorInputs: string[] = [];
    const streamImpl: typeof aiStreamRound = async (options, callbacks) => {
      if (!isValidatorCall(options)) return script.impl(options, callbacks);
      const input = String(options.messages[1]?.content ?? '');
      validatorInputs.push(input);
      const text = input.includes(`<assistant_response>\n${CLAIM}\n</assistant_response>`)
        ? 'REJECT: receipt does not confirm delivery to the invitee'
        : 'APPROVE';
      return {
        text,
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: text },
        providerUsed: 'synthetic-validator',
      };
    };
    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl }).run(ctx);
      expect(result.toolCalls.filter((call) => call.name === 'add_contact')).toHaveLength(1);
      expect(result.toolResults[0]?.success).toBe(false);
      expect(ctx.contactRepo.findByNameStrict(USER_ID, 'Alice')?.preferred_name).toBeNull();
      expect(validatorInputs).toHaveLength(2);
      expect(validatorInputs[0]).toContain(JSON.stringify(ctx.invitationDeliveryReceipts));
      expect(result.responseText).toBe(CORRECTION);
      expect(shownEdits(sender).at(-1)).not.toContain(CLAIM);
      expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain(CLAIM);
    } finally {
      db.close();
    }
  });
});

/** The validator rejects the invented delivery claim, then accepts the corrected explanation. */
function withDeliveryValidator(script: ReturnType<typeof makeStreamImpl>): typeof aiStreamRound {
  return async (options, callbacks) => {
    if (!isValidatorCall(options)) return script.impl(options, callbacks);
    const input = String(options.messages[1]?.content ?? '');
    const text = input.includes(`<assistant_response>\n${CLAIM}\n</assistant_response>`)
      ? 'REJECT: delivery to the invitee was not confirmed'
      : 'APPROVE';
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: text },
      providerUsed: 'synthetic-validator',
    };
  };
}

const PICKER_PATHS = (['full', 'lazy'] as const).flatMap((toolSchemaMode) =>
  (['initial', 'provider', 'weekday', 'validator'] as const).map((entry) => ({ toolSchemaMode, entry })),
);

type PickerPath = (typeof PICKER_PATHS)[number];

function buildPickerContinuationScript({ toolSchemaMode, entry }: PickerPath, eventId: number, invitationId: number) {
  const rounds: ScriptedRound[] = [];
  const tool = (callId: string, name: string, input: { [key: string]: unknown }) =>
    rounds.push({ kind: 'tool', callId, name, input });
  if (toolSchemaMode === 'lazy') {
    tool('write-schemas', 'discover_tools', {
      tools: ['add_contact', 'update_contact', 'resend_invitation', 'send_invitation', 'find_user'],
    });
  }
  if (entry === 'weekday' || entry === 'validator') {
    rounds.push({ kind: 'text', text: entry === 'weekday' ? `Tuesday, 2026-11-16. ${CLAIM}` : CLAIM });
  }
  const providerDiscardRound = rounds.length;
  tool('unauthorized-resend', 'resend_invitation', { invitation_id: invitationId });
  tool('unauthorized-send', 'send_invitation', { event_id: eventId, invitee_id: 201 });
  tool('invented-alias', 'add_contact', {
    name: 'Alice',
    preferred_name: 'Invented alias',
    username: 'alice_test',
  });
  tool('unauthorized-update', 'update_contact', { search: 'Alice', preferred_name: 'Another invented alias' });
  if (entry === 'initial') {
    tool('unselected-contact', 'add_contact', { name: 'Mallory', preferred_name: 'Mal' });
    tool('changed-identity', 'add_contact', { name: 'Alice', preferred_name: 'Ally', username: 'changed_user' });
    tool('extra-identity-fields', 'add_contact', {
      name: 'Alice',
      preferred_name: 'Ally',
      telegram_id: 201,
      email: 'other@example.test',
    });
  }
  tool('lookup-without-session', 'find_user', { username: 'alice_test' });
  if (toolSchemaMode === 'lazy') tool('read-schema', 'discover_tools', { tools: ['get_invitation_status'] });
  tool('read-invitation', 'get_invitation_status', { event_id: eventId });
  rounds.push({ kind: 'text', text: CORRECTION });
  const script = makeStreamImpl(rounds);
  return { script, providerDiscardRound };
}

describe('read-only picker continuation', () => {
  test.each(
    PICKER_PATHS,
  )('$toolSchemaMode schemas, $entry path: preserves contacts and delivery; a new user may rename and resend', async ({
    toolSchemaMode,
    entry,
  }) => {
    const { db, ctx, config, sender } = createAgentRunFixture();
    const event = setupInvitations(db, ctx);
    const sharing = ctx.sharing!;
    ctx.contactRepo = new ContactRepository(db);
    const existingAlias = entry === 'weekday' || entry === 'validator' ? 'Existing Alice' : undefined;
    if (existingAlias) ctx.contactRepo.upsert(USER_ID, 'Alice', 'alice_test', 201, existingAlias);
    ctx.telegramSessionRepo = new TelegramSessionRepository(db);
    ctx.telegramMasterKey = Buffer.alloc(32, 1);
    ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
    ctx.botUsername = 'TestBot';
    ctx.sender = sender;
    const reconnect = mock(async () => ({ message_id: 902 }));
    sender.sendMessageWithKeyboard = reconnect;
    const invitationCreates = spyOn(sharing.invitationService, 'sendInvitation');
    const recipientAttempts: number[] = [];
    let acknowledgeDelivery = false;
    sender.sendInvitation = async (recipientId) => {
      recipientAttempts.push(recipientId);
      return acknowledgeDelivery ? { message_id: 600 + recipientAttempts.length } : null;
    };
    try {
      const selected = [{ userId: 201, firstName: 'Alice', username: 'alice_test' }];
      const picker = await deliverPickerInvitations(
        { eventId: event.id, inviter: ctx.user, lang: 'en', fallbackChatId: USER_ID, invitees: selected },
        {
          sender,
          invitationService: sharing.invitationService,
          eventService: ctx.eventService,
          invitationRepo: sharing.invitationRepo,
          userRepo: ctx.userRepo,
          contactRepo: ctx.contactRepo,
          deepLinkService: ctx.deepLinkService,
          botUsername: ctx.botUsername,
        },
      );
      expect(picker.receipts).toEqual([{ eventId: event.id, recipientId: 201, outcome: 'manual_forward' }]);
      // The real picker saves the Telegram identity before AI, retaining any existing preferred name.
      const savedContact = ctx.contactRepo.findByTelegramId(USER_ID, 201)!;
      expect(savedContact).toMatchObject({
        name: 'Alice',
        username: 'alice_test',
        telegram_id: 201,
        preferred_name: existingAlias ?? null,
      });
      const original = sharing.invitationRepo.getByEvent(event.id)[0]!;
      const { script, providerDiscardRound } = buildPickerContinuationScript(
        { toolSchemaMode, entry },
        event.id,
        original.id,
      );
      const validatedStream = withDeliveryValidator(script);
      let providerSwitches = 0;
      const streamImpl: typeof aiStreamRound = async (options, callbacks) => {
        if (entry === 'provider' && !isValidatorCall(options) && script.calls.length === providerDiscardRound) {
          callbacks?.onTextDelta?.('Changing the contact name now.');
          callbacks?.onProviderSwitch?.();
          providerSwitches++;
        }
        return validatedStream(options, callbacks);
      };
      const agent = new CalendarBotAgent({ ...config, toolSchemaMode }, sender, { streamImpl });
      const runs: Awaited<ReturnType<CalendarBotAgent['run']>>[] = [];
      ctx.chatHistory.save(USER_ID, 'user', 'Invite Alice to the event.');
      await continueWithAgent(
        ctx.user,
        buildPickerResultMessage(selected, picker.aiResultLines),
        {
          agent: {
            run: async (runCtx) => {
              const result = await agent.run(runCtx);
              runs.push(result);
              return result;
            },
          },
          buildContext: (user, chatId, messageText) => ({ ...ctx, user, chatId, messageText }),
        },
        USER_ID,
        undefined,
        picker.receipts,
      );
      const result = runs[0]!;
      expect(recipientAttempts).toEqual([201]);
      expect(invitationCreates).toHaveBeenCalledTimes(1);
      expect(sharing.invitationRepo.getByEvent(event.id)).toEqual([original]);
      expect(reconnect).not.toHaveBeenCalled();
      expect(result.metrics?.termination).not.toBe('waiting');
      expect(ctx.contactRepo.findByTelegramId(USER_ID, 201)).toEqual(savedContact);
      expect(ctx.contactRepo.findByNameStrict(USER_ID, 'Mallory')).toBeNull();
      for (const name of ['resend_invitation', 'send_invitation', 'add_contact', 'update_contact']) {
        const index = result.toolCalls.findIndex((call) => call.name === name);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(result.toolResults[index]?.success).toBe(false);
      }
      const lookupIndex = result.toolCalls.findIndex((call) => call.name === 'find_user');
      expect(result.toolResults[lookupIndex]?.success).toBe(false);
      const readIndex = result.toolCalls.findIndex((call) => call.name === 'get_invitation_status');
      expect(result.toolResults[readIndex]?.success).toBe(true);
      expect(result.responseText).toBe(CORRECTION);
      const feedback = script.calls.flatMap((call) => call.messages).filter((message) => message.role === 'tool');
      const deniedIds = [
        'unauthorized-resend',
        'unauthorized-send',
        'invented-alias',
        'unauthorized-update',
        ...(entry === 'initial' ? ['unselected-contact', 'changed-identity', 'extra-identity-fields'] : []),
      ];
      for (const id of deniedIds) {
        expect(
          feedback.some((message) => message.tool_call_id === id && String(message.content).includes('not permitted')),
        ).toBe(true);
      }
      if (entry === 'weekday') {
        expect(
          script.calls.some((call) =>
            call.messages.some((message) => String(message.content).includes('Your reply was not sent')),
          ),
        ).toBe(true);
      }
      expect(providerSwitches).toBe(entry === 'provider' ? 1 : 0);
      if (toolSchemaMode === 'lazy') {
        expect(
          feedback.some(
            (message) =>
              message.tool_call_id === 'read-schema' &&
              String(message.content).includes('"activated":["get_invitation_status"]'),
          ),
        ).toBe(true);
      }

      // An actual new user turn grants normal writes, including changing an existing preferred name.
      acknowledgeDelivery = true;
      ctx.messageText = 'Please rename Alice to Ally and resend her pending invitation.';
      ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
      const requested = makeStreamImpl([
        ...(toolSchemaMode === 'lazy'
          ? [
              {
                kind: 'tool' as const,
                callId: 'requested-schemas',
                name: 'discover_tools',
                input: { tools: ['update_contact', 'resend_invitation'] },
              },
            ]
          : []),
        { kind: 'text', text: CLAIM },
        {
          kind: 'tool',
          callId: 'requested-alias',
          name: 'update_contact',
          input: { search: 'Alice', preferred_name: 'Ally' },
        },
        { kind: 'tool', callId: 'requested-resend', name: 'resend_invitation', input: { invitation_id: original.id } },
        { kind: 'text', text: 'Alice is saved as Ally. The invitation reminder was sent.' },
      ]);
      expect(ctx.invitationDeliveryReceipts).toBeUndefined();
      const requestedResult = await new CalendarBotAgent({ ...config, toolSchemaMode }, sender, {
        streamImpl: withDeliveryValidator(requested),
      }).run(ctx);
      expect(recipientAttempts).toEqual([201, 201]);
      expect(requestedResult.toolResults[0]?.success).toBe(true);
      expect(requestedResult.toolResults[1]?.success).toBe(true);
      expect(ctx.contactRepo.findByTelegramId(USER_ID, 201)).toEqual({ ...savedContact, preferred_name: 'Ally' });
      expect(requestedResult.responseText).toBe('Alice is saved as Ally. The invitation reminder was sent.');
    } finally {
      invitationCreates.mockRestore();
      db.close();
    }
  });
});
