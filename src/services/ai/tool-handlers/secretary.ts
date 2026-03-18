import { InlineKeyboard } from 'gramio';
import type { CalendarSecretary } from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { deliverMessage } from '../deliver-message.ts';
import type { AgentContext, ToolResult } from '../types.ts';

const secretaryLogger = botLogger.child({ module: 'secretary' });

interface ManageSecretariesInput {
  action: 'invite' | 'revoke' | 'self_remove';
  secretary_telegram_id?: number;
  permission?: 'read' | 'write';
  secretary_access_id?: number;
}

async function sendSecretaryInvite(
  ctx: AgentContext,
  record: CalendarSecretary,
  secretaryUser: { telegram_id: number; username?: string | null; first_name?: string | null },
): Promise<void> {
  if (!ctx.sender) return;

  const ownerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  const ownerHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
  const permLabel = record.permission === 'write' ? 'читать и редактировать' : 'только просматривать';
  const text =
    `${ownerName}${ownerHandle} хочет добавить тебя секретарём своего календаря.\n` +
    `Права доступа: ${permLabel}.\n\n` +
    `Принять приглашение?`;

  const keyboard = new InlineKeyboard()
    .text('Принять ✅', `sec:accept:${record.id}`)
    .text('Отклонить ❌', `sec:decline:${record.id}`);

  const sender = ctx.sender;

  const result = await deliverMessage({
    targetId: secretaryUser.telegram_id,
    targetUsername: secretaryUser.username ?? undefined,
    text,
    keyboard,
    fallbackRecipientId: ctx.user.telegram_id,
    fallbackText: `Не удалось доставить приглашение — пользователь ещё не запускал бота.`,
    botSend: async (recipientId, msg, kb) => {
      if (kb && sender.sendMessageWithKeyboard) {
        return sender.sendMessageWithKeyboard(recipientId, msg, kb);
      }
      return sender.sendMessage(recipientId, msg);
    },
    mtprotoSend: sender.sendAsUser?.bind(sender),
  });

  if (result.messageId) {
    ctx.secretaryRepo!.setDmMessageId(record.id, result.messageId);
  }
}

export function handleManageSecretaries(ctx: AgentContext, input: ManageSecretariesInput): ToolResult {
  if (!ctx.secretaryRepo || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  if (input.action === 'invite') {
    const { secretary_telegram_id, permission } = input;
    if (!secretary_telegram_id || !permission)
      return { success: false, error: 'secretary_telegram_id and permission required for invite.' };

    const secretaryUser = ctx.userRepo.findByTelegramId(secretary_telegram_id);
    if (!secretaryUser) return { success: false, error: 'SECRETARY_NOT_FOUND' };

    if (ctx.secretaryRepo.countActive(ctx.user.telegram_id) >= 10)
      return { success: false, error: 'SECRETARY_LIMIT_REACHED' };

    const record = ctx.secretaryRepo.upsert({
      owner_id: ctx.user.telegram_id,
      secretary_id: secretary_telegram_id,
      permission,
    });

    sendSecretaryInvite(ctx, record, secretaryUser).catch((err: unknown) => {
      secretaryLogger.error({ err, recordId: record.id }, 'Failed to send secretary invite');
    });

    return {
      success: true,
      output: JSON.stringify({ status: 'awaiting_confirmation', secretary_access_id: record.id }),
    };
  }

  // revoke and self_remove handled in Task 6
  return { success: false, error: `Unknown action: ${(input as { action: string }).action}` };
}

export function handleListCalendarAccess(ctx: AgentContext): ToolResult {
  if (!ctx.secretaryRepo || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  const secretaryForRecords = ctx.secretaryRepo.getActiveSecretaryFor(ctx.user.telegram_id);
  const mySecretaryRecords = ctx.secretaryRepo.getSecretariesForOwner(ctx.user.telegram_id);

  const enrichUser = (telegramId: number) => {
    const u = ctx.userRepo!.findByTelegramId(telegramId);
    return {
      telegram_id: telegramId,
      username: u?.username,
      display_name: u?.first_name ?? u?.username ?? `User ${telegramId}`,
    };
  };

  return {
    success: true,
    output: JSON.stringify({
      own: enrichUser(ctx.user.telegram_id),
      my_secretaries: mySecretaryRecords.map((r) => ({ ...r, ...enrichUser(r.secretary_id) })),
      secretary_for: secretaryForRecords.map((r) => ({ ...r, ...enrichUser(r.owner_id) })),
    }),
  };
}
