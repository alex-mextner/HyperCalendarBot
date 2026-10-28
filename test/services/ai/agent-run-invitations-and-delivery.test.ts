import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { approveDeletes } from '../../../src/services/ai/delete-confirmation.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import type { AgentConfig, AgentContext, TelegramSender } from '../../../src/services/ai/types.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import {
  createAgentRunFixture,
  isValidatorCall,
  makeStreamImpl,
  setupInvitations,
  USER_ID,
} from './agent-run-helpers.ts';

describe('CalendarBotAgent.run()', () => {
  let db: Database;
  let ctx: AgentContext;
  let config: AgentConfig;
  let sender: TelegramSender;

  beforeEach(() => {
    ({ db, ctx, config, sender } = createAgentRunFixture());
  });

  test.each([
    'create_event',
    'update_event',
    'send_invitation',
  ])('known preflight rejection is not an uncertain write: %s', async (name) => {
    const input =
      name === 'create_event'
        ? { title: 'Synthetic', start_at: new Date(Date.now() - 3600000).toISOString() }
        : name === 'update_event'
          ? { event_id: 999999, title: 'Synthetic' }
          : { event_id: 999999, invitee_id: 456 };
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'rejected', name, input },
      { kind: 'error', error: new Error('Synthetic provider interruption') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toContain('Not completed:');
    expect(result.responseText).toContain('request rejected before applying changes');
    expect(result.responseText).not.toContain('Outcome unknown');
    expect(result.responseText).not.toContain('Confirmed changes remain');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('production metrics include hidden validator call and sanitized delivery result', async () => {
    ctx.chatHistory.save(USER_ID, 'user', 'hello');
    const scripted = makeStreamImpl([{ kind: 'text', text: 'hello back' }]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: scripted.impl }).run(ctx);
    expect(result.metrics).toMatchObject({
      modelCalls: 2,
      modelAttempts: 2,
      promptTokens: 110,
      completionTokens: 22,
      termination: 'normal',
      deliveryOutcome: 'delivered',
    });
    expect(result.metrics?.usagePartialRounds).toBe(2);
    // A duration or random request UUID can incidentally contain the actor's digits.
    // Pin the semantic telemetry contract, not substrings of unrelated measurements.
    expect(Object.keys(result.metrics ?? {}).sort()).toEqual(
      [
        'requestId',
        'elapsedMs',
        'firstVisibleMs',
        'modelDurationMs',
        'toolDurationMs',
        'deliveryActionMs',
        'modelCalls',
        'modelAttempts',
        'providerFallbacks',
        'promptTokens',
        'completionTokens',
        'reportedTotalTokens',
        'reasoningTokens',
        'cachedTokens',
        'usageMissingRounds',
        'usagePartialRounds',
        'termination',
        'deliveryOutcome',
      ].sort(),
    );
  });

  test('post-update loss of read visibility is uncertain, never a pre-apply rejection', async () => {
    const groupId = -1007755;
    new GroupMemberRepository(db).upsert(groupId, USER_ID);
    db.run('UPDATE group_members SET joined_at=? WHERE chat_id=? AND user_id=?', [
      '2030-01-01T11:00:00Z',
      groupId,
      USER_ID,
    ]);
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      owner_type: 'group',
      group_id: groupId,
      created_by: USER_ID,
      title: 'Synthetic group event',
      start_at: '2030-01-01T12:00:00Z',
      timezone: 'UTC',
    });
    const enqueue = mock(async () => true);
    ctx.retryEnqueue = enqueue;
    const script = makeStreamImpl([
      {
        kind: 'tool',
        callId: 'move',
        name: 'update_event',
        input: { event_id: event.id, scope: 'personal', start_at: '2030-01-01T10:00:00Z' },
      },
      { kind: 'error', error: new Error('Synthetic provider interruption') },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    const stored = db.query('SELECT start_at FROM events WHERE id=?').get(event.id) as { start_at: string };
    expect(stored.start_at).toBe('2030-01-01T10:00:00Z');
    expect(result.responseText).toContain('Outcome unknown');
    expect(result.responseText).not.toContain('request rejected before applying changes');
    expect(enqueue).not.toHaveBeenCalled();
  });

  test('nested invitation picker remains a waiting handoff', async () => {
    const event = setupInvitations(db, ctx);
    ctx.messageText = 'Invite @private_name';
    ctx.resolveUsername = async () => null;
    sender.sendUserPicker = mock(async () => ({ message_id: 43 }));
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      {
        kind: 'tool',
        callId: 'picker',
        name: 'send_invitation',
        input: { event_id: event.id, invitee_username: 'private_name' },
      },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(result.responseText).toBe('');
    expect(sender.sendUserPicker).toHaveBeenCalledTimes(1);
    expect(db.query('SELECT id FROM invitations WHERE event_id = ?').all(event.id)).toHaveLength(0);
    expect(JSON.stringify(ctx.chatHistory.getRecent(USER_ID))).not.toContain('Completed: Send invitation');
  });

  test.each([
    'failed',
    'manual',
    'delivered',
  ])('invitation reports actual %s delivery in a mixed group report', async (delivery) => {
    const event = setupInvitations(db, ctx);
    ctx.isGroup = true;
    ctx.chatId = -1009988;
    ctx.groupChatId = ctx.chatId;
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC', language: 'en' });
    ctx.verifiedRecipientIds = new Set([789]); // The user selected this numeric recipient.
    sender.sendInvitation = async () => (delivery === 'delivered' ? { message_id: 55 } : null);
    const privateMessages: string[] = [];
    sender.sendMessage = async (chatId, text) => {
      if (chatId === USER_ID) privateMessages.push(text);
      return { message_id: 55 };
    };
    if (delivery === 'manual') {
      ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
      ctx.botUsername = 'synthetic_bot';
    }
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'tool', callId: 'invite', name: 'send_invitation', input: { event_id: event.id, invitee_id: 789 } },
      { kind: 'text', text: 'Everything sent.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(db.query('SELECT id FROM invitations WHERE event_id = ?').all(event.id)).toHaveLength(1);
    expect(result.responseText).toContain(delivery === 'delivered' ? 'Invitation delivered' : 'Invitation created');
    expect(result.responseText).toContain(
      delivery === 'manual' ? 'forward' : delivery === 'failed' ? 'not delivered' : 'delivered',
    );
    expect(result.responseText).not.toContain('789');
    expect(result.responseText).not.toContain('<b>private');
    expect(result.responseText).not.toContain('https://');
    if (delivery === 'manual') expect(privateMessages.join('')).toContain('https://t.me/');
    const groupHistory = ctx.chatHistory.getRecentByChat(ctx.chatId);
    expect(groupHistory.some((row) => row.role === 'tool')).toBe(true);
    expect(JSON.stringify(groupHistory)).toContain(
      delivery === 'delivered' ? 'Invitation delivered' : 'Invitation created',
    );
    expect(JSON.stringify(groupHistory)).not.toContain('Everything sent.');
  });

  test('group execution log never leaks raw tool argument values (invitee_id)', async () => {
    const event = setupInvitations(db, ctx);
    ctx.isGroup = true;
    ctx.chatId = -1009988;
    ctx.groupChatId = ctx.chatId;
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC', language: 'en' });
    ctx.verifiedRecipientIds = new Set([789]);
    sender.sendInvitation = async () => null; // failed delivery — keeps the evidence guard active
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'tool', callId: 'invite', name: 'send_invitation', input: { event_id: event.id, invitee_id: 789 } },
      { kind: 'text', text: 'Everything sent.' },
    ]);
    await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    // The execution log block is group-visible history — raw target IDs must never appear in it,
    // even though the tool names/status still do (regression for the resetForGuard PII leak).
    const logMatch = delivered.match(/<blockquote expandable>[\s\S]*?<\/blockquote>/);
    expect(logMatch).not.toBeNull();
    const executionLog = logMatch![0];
    expect(executionLog).toContain('Execution log');
    expect(executionLog).not.toContain('789');
    expect(executionLog).not.toContain('event_id');
    expect(executionLog).not.toContain('invitee_id');
  });

  test('group execution log never leaks raw tool argument values from the retry loop (invitee_id)', async () => {
    // Same PII-redaction contract as the main-loop test above, but driven through
    // runRetryAfterRejection's own setToolLabel call site, which has the identical
    // `ctx.isGroup ? undefined : input` fix but no dedicated test.
    const event = setupInvitations(db, ctx);
    ctx.isGroup = true;
    ctx.chatId = -1009988;
    ctx.groupChatId = ctx.chatId;
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC', language: 'en' });
    ctx.verifiedRecipientIds = new Set([789]);
    sender.sendInvitation = async () => null; // failed delivery — keeps the evidence guard active
    let delivered = '';
    sender.editMessageText = async (_chatId, _messageId, text) => {
      delivered = text;
    };
    const script = makeStreamImpl([
      { kind: 'text', text: 'Unverified answer' },
      { kind: 'tool', callId: 'retry-invite', name: 'send_invitation', input: { event_id: event.id, invitee_id: 789 } },
      { kind: 'text', text: 'Приглашение отправлено.' },
    ]);
    const impl = async (opts: StreamRoundOptions, callbacks?: StreamCallbacks): Promise<StreamRoundResult> => {
      if (isValidatorCall(opts))
        return {
          text: 'REJECT: missing evidence',
          toolCalls: [],
          finishReason: 'stop',
          assistantMessage: { role: 'assistant', content: 'REJECT: missing evidence' },
          providerUsed: 'synthetic',
        };
      return script.impl(opts, callbacks);
    };
    await new CalendarBotAgent(config, sender, { streamImpl: impl }).run(ctx);
    const logMatch = delivered.match(/<blockquote expandable>[\s\S]*?<\/blockquote>/);
    expect(logMatch).not.toBeNull();
    const executionLog = logMatch![0];
    expect(executionLog).toContain('Invitation');
    expect(executionLog).not.toContain('789');
    expect(executionLog).not.toContain('event_id');
    expect(executionLog).not.toContain('invitee_id');
  });

  test('participant delete reports attendance decline while retaining the event', async () => {
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC' });
    const event = ctx.eventService.createEvent({
      user_id: 789,
      title: 'Shared',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      timezone: 'UTC',
    });
    approveDeletes(USER_ID, ctx.chatId, [event.id]);
    ctx.participantRepo = new ParticipantRepository(db);
    ctx.participantRepo.add(event.id, USER_ID, 'accepted');
    const script = makeStreamImpl([
      { kind: 'tool', callId: 'bad', name: 'delete_event', input: { event_id: 999999 } },
      { kind: 'tool', callId: 'decline', name: 'delete_event', input: { event_id: event.id } },
      { kind: 'text', text: 'Deleted everything.' },
    ]);
    const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
    expect(ctx.eventService.getEvent(event.id, 789)).not.toBeNull();
    expect(ctx.participantRepo.findByEventAndUser(event.id, USER_ID)?.status).toBe('declined');
    expect(result.responseText).toContain('Attendance declined');
    expect(result.responseText).not.toContain('Completed: Delete event');
  });
});
