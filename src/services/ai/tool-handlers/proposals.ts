import { InlineKeyboard } from 'gramio';
import type { CalendarProposalRepository } from '../../../database/repositories/calendar-proposal.repository.ts';
import type { CreateEventData, UpdateEventData } from '../../../database/types.ts';
import { logger } from '../../../utils/logger.ts';
import { deliverMessage } from '../deliver-message.ts';
import type { AgentContext, ToolResult } from '../types.ts';

const proposalLogger = logger.child({ module: 'proposals' });

export interface ProposeInput {
  target_telegram_id: number;
  action: 'create' | 'update' | 'delete';
  summary: string;
  event?: Omit<CreateEventData, 'user_id'>;
  event_id?: number;
  changes?: UpdateEventData;
}

export async function handleProposeCalendarChange(ctx: AgentContext, input: ProposeInput): Promise<ToolResult> {
  const calendarProposalRepo = ctx.calendarProposalRepo;
  if (!calendarProposalRepo) {
    return { success: false, error: 'Proposals feature not configured.' };
  }

  const inChat = ctx.checkGroupMembership
    ? await ctx.checkGroupMembership(ctx.chatId, input.target_telegram_id)
    : false;
  if (!inChat) {
    return { success: false, error: 'PROPOSAL_TARGET_NOT_IN_CHAT' };
  }

  const expiresAt = computeExpiresAt(input);
  const payload = buildPayload(input);

  const proposal = calendarProposalRepo.create({
    group_chat_id: ctx.chatId,
    group_chat_title: ctx.groupTitle ?? undefined,
    proposer_id: ctx.user.telegram_id,
    target_id: input.target_telegram_id,
    action: input.action,
    payload: JSON.stringify(payload),
    summary: input.summary,
    expires_at: expiresAt,
  });

  deliverProposalDm(ctx, calendarProposalRepo, proposal, input.target_telegram_id).catch((err) =>
    proposalLogger.error({ err }, 'proposal DM delivery failed'),
  );

  notifyGroupChat(ctx, calendarProposalRepo, proposal, input.target_telegram_id).catch((err) =>
    proposalLogger.error({ err }, 'proposal group notification failed'),
  );

  return { success: true, output: JSON.stringify({ status: 'awaiting_confirmation', proposal_id: proposal.id }) };
}

function computeExpiresAt(input: ProposeInput): string {
  if (input.action === 'create' && input.event?.end_at) return input.event.end_at as string;
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function buildPayload(input: ProposeInput): unknown {
  if (input.action === 'create') return { action: 'create', event: input.event };
  if (input.action === 'update') return { action: 'update', event_id: input.event_id, changes: input.changes };
  return { action: 'delete', event_id: input.event_id };
}

async function deliverProposalDm(
  ctx: AgentContext,
  repo: CalendarProposalRepository,
  proposal: { id: number; summary: string },
  targetId: number,
): Promise<void> {
  if (!ctx.sender) return;

  const proposerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  const proposerHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
  const chatName = ctx.groupTitle ?? `chat ${ctx.chatId}`;
  const text =
    `${proposerName}${proposerHandle} предлагает изменение в твоём календаре (чат "${chatName}"):\n\n` +
    `${proposal.summary}`;

  const keyboard = new InlineKeyboard()
    .text('Принять ✅', `prop:accept:${proposal.id}`)
    .text('Отклонить ❌', `prop:decline:${proposal.id}`);

  const targetUser = ctx.userRepo.findByTelegramId(targetId);
  const sender = ctx.sender;

  const result = await deliverMessage({
    targetId,
    targetUsername: targetUser?.username ?? undefined,
    text,
    keyboard,
    fallbackRecipientId: ctx.user.telegram_id,
    fallbackText: 'Не удалось доставить предложение — пользователь ещё не запускал бота.',
    botSend: async (id, msg, kb) => {
      if (kb && sender.sendMessageWithKeyboard) {
        return sender.sendMessageWithKeyboard(id, msg, kb);
      }
      return sender.sendMessage(id, msg);
    },
    mtprotoSend: sender.sendAsUser?.bind(sender),
  });

  if (result.messageId) {
    repo.setDmMessageId(proposal.id, result.messageId);
  }
}

async function notifyGroupChat(
  ctx: AgentContext,
  repo: CalendarProposalRepository,
  proposal: { id: number },
  targetId: number,
): Promise<void> {
  if (!ctx.sendMessageToChat) return;
  const targetUser = ctx.userRepo.findByTelegramId(targetId);
  const targetName = targetUser?.first_name ?? targetUser?.username ?? `User ${targetId}`;
  const targetHandle = targetUser?.username ? ` (@${targetUser.username})` : '';

  const msg = (await ctx.sendMessageToChat(
    ctx.chatId,
    `Отправил предложение ${targetName}${targetHandle}. Она/он ответит в личных сообщениях.`,
    { reply_markup: new InlineKeyboard().url('→ Написать боту', `https://t.me/${ctx.botUsername ?? 'bot'}`) },
  )) as { message_id: number };

  if (msg?.message_id) {
    repo.setGroupMessageId(proposal.id, msg.message_id);
  }
}
