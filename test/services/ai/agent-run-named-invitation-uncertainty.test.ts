import { describe, expect, test } from 'bun:test';
import { DeepLinkRepository } from '../../../src/database/repositories/deep-link.repository.ts';
import { CalendarBotAgent } from '../../../src/services/ai/agent.ts';
import { DeepLinkService } from '../../../src/services/sharing/deep-link-service.ts';
import { createAgentRunFixture, makeStreamImpl, setupInvitations, shownEdits, USER_ID } from './agent-run-helpers.ts';

const cases: ['en' | 'ru', 'with' | 'without', number][] = [
  ['en', 'with', 1],
  ['en', 'with', 2],
  ['en', 'without', 1],
  ['en', 'without', 2],
  ['ru', 'with', 1],
  ['ru', 'with', 2],
  ['ru', 'without', 1],
  ['ru', 'without', 2],
];

function invitationPrefix(language: 'en' | 'ru', count: number): string {
  if (language === 'en') return count === 1 ? 'The invitation to ' : 'The invitations to ';
  return count === 1 ? 'Приглашение на ' : 'Приглашения на ';
}

function forwardingCondition(language: 'en' | 'ru', count: number): string {
  if (language === 'en') {
    return count === 1
      ? 'If the invitation did not arrive, forward the link'
      : 'only to people who did not receive an invitation';
  }
  return count === 1 ? 'Если приглашение не пришло, перешли ссылку' : 'только тем, кто не получил приглашение';
}

describe('named invitation final receipts after a lost acknowledgement', () => {
  test.each(cases)('%s: forwarding link=%s, named recipients=%i', async (language, linkMode, count) => {
    const hasForwardLink = linkMode === 'with';
    const { db, ctx, config, sender } = createAgentRunFixture();
    ctx.user.language = language;
    ctx.sender = sender;
    const event = setupInvitations(db, ctx);
    const sharing = ctx.sharing!;
    const recipients = [
      { id: 820201, name: 'Alice' },
      { id: 820202, name: 'Bob' },
    ].slice(0, count);
    for (const recipient of recipients) {
      ctx.userRepo.create({
        telegram_id: recipient.id,
        first_name: recipient.name,
        username: recipient.name.toLowerCase(),
        timezone: 'UTC',
        language,
      });
    }
    if (hasForwardLink) {
      ctx.deepLinkService = new DeepLinkService(new DeepLinkRepository(db));
      ctx.botUsername = 'SyntheticTestBot';
    }
    const messages: { chatId: number; text: string }[] = [];
    sender.sendMessage = async (chatId, text) => {
      messages.push({ chatId, text });
      return { message_id: 900 + messages.length };
    };
    const attemptedRecipients: number[] = [];
    const originals: ReturnType<typeof sharing.invitationRepo.getByEvent> = [];
    sender.sendInvitation = async (recipientId, _text, invitationId) => {
      attemptedRecipients.push(recipientId);
      const invitation = sharing.invitationRepo.getByEvent(event.id).find((row) => row.id === invitationId);
      if (!invitation) throw new Error('Synthetic invitation row missing before delivery');
      originals.push(invitation);
      // The transport cannot tell whether the recipient got the invitation before the acknowledgement was lost.
      return null;
    };
    const handles = recipients.map((recipient) => `@${recipient.name.toLowerCase()}`);
    ctx.messageText = language === 'en' ? `Invite ${handles.join(' and ')}.` : `Пригласи ${handles.join(' и ')}.`;
    ctx.chatHistory.save(USER_ID, 'user', ctx.messageText);
    const script = makeStreamImpl([
      ...recipients.map((recipient) => ({
        kind: 'tool' as const,
        callId: `invite-${recipient.id}`,
        name: 'send_invitation',
        input: { event_id: event.id, invitee_username: recipient.name.toLowerCase() },
      })),
      { kind: 'text', text: 'MODEL SUMMARY SHOULD BE REPLACED' },
    ]);

    try {
      const result = await new CalendarBotAgent(config, sender, { streamImpl: script.impl }).run(ctx);
      expect(result.toolCalls.filter((call) => call.name === 'send_invitation')).toHaveLength(count);
      expect(attemptedRecipients).toEqual(recipients.map((recipient) => recipient.id));
      const rows = sharing.invitationRepo.getByEvent(event.id);
      expect(rows).toHaveLength(count);
      expect(originals).toHaveLength(count);
      for (const original of originals) expect(rows.find((row) => row.id === original.id)).toEqual(original);
      for (const handle of handles) expect(result.responseText).toContain(handle);

      const uncertainty = language === 'en' ? 'Direct delivery is unconfirmed.' : 'Прямая доставка не подтверждена.';
      expect(result.responseText).toContain(uncertainty);
      expect(result.responseText).not.toMatch(/not delivered|не доставлен/i);
      expect(result.responseText).not.toContain('MODEL SUMMARY SHOULD BE REPLACED');
      expect(result.responseText).toContain(invitationPrefix(language, count));
      expect(shownEdits(sender).at(-1)).toContain(uncertainty);
      const forwardedLinks = messages.filter(({ text }) => text.includes('https://t.me/SyntheticTestBot?start='));
      expect(forwardedLinks).toHaveLength(hasForwardLink ? count : 0);
      for (const message of forwardedLinks) expect(message.chatId).toBe(USER_ID);
      if (hasForwardLink) {
        const condition = forwardingCondition(language, count);
        expect(result.responseText).toContain(condition);
      } else {
        expect(result.responseText).not.toMatch(/forward|перешли/i);
      }
    } finally {
      db.close();
    }
  });
});
