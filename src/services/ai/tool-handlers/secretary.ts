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
    .text('✅ Принять', `sec:accept:${record.id}`)
    .text('❌ Отклонить', `sec:decline:${record.id}`);

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
    ctx.secretary!.secretaryRepo.setDmMessageId(record.id, result.messageId);
  }
}

async function sendSecretaryNotification(
  ctx: AgentContext,
  targetId: number,
  targetUsername: string | null | undefined,
  text: string,
): Promise<void> {
  if (!ctx.sender) return;
  await deliverMessage({
    targetId,
    targetUsername: targetUsername ?? undefined,
    text,
    fallbackRecipientId: ctx.user.telegram_id,
    fallbackText: text,
    botSend: async (id, msg) => {
      const sent = await ctx.sender!.sendMessage(id, msg);
      return { message_id: sent.message_id };
    },
    mtprotoSend: ctx.sender.sendAsUser?.bind(ctx.sender),
  });
}

export function handleManageSecretaries(ctx: AgentContext, input: ManageSecretariesInput): ToolResult {
  if (!ctx.secretary || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  if (input.action === 'invite') {
    const { secretary_telegram_id, permission } = input;
    if (!secretary_telegram_id || !permission)
      return { success: false, error: 'secretary_telegram_id and permission required for invite.' };

    const secretaryUser = ctx.userRepo.findByTelegramId(secretary_telegram_id);
    if (!secretaryUser) return { success: false, error: 'SECRETARY_NOT_FOUND' };

    if (ctx.secretary!.secretaryRepo.countActive(ctx.user.telegram_id) >= 10)
      return { success: false, error: 'SECRETARY_LIMIT_REACHED' };

    const record = ctx.secretary!.secretaryRepo.upsert({
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

  if (input.action === 'revoke') {
    if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for revoke.' };
    const record = ctx.secretary!.secretaryRepo.findById(input.secretary_access_id);
    if (!record || record.owner_id !== ctx.user.telegram_id)
      return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

    ctx.secretary!.secretaryRepo.updateStatus(record.id, 'revoked');

    const secUser = ctx.userRepo!.findByTelegramId(record.secretary_id);
    if (secUser && ctx.sender) {
      const ownerName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
      const ownerHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
      sendSecretaryNotification(
        ctx,
        record.secretary_id,
        secUser.username,
        `Твой доступ к календарю ${ownerName}${ownerHandle} был отозван.`,
      ).catch((err: unknown) => secretaryLogger.error({ err }, 'failed to send revoke notification'));
    }
    return { success: true, output: JSON.stringify({ ok: true }) };
  }

  if (input.action === 'self_remove') {
    if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for self_remove.' };
    const record = ctx.secretary!.secretaryRepo.findById(input.secretary_access_id);
    if (!record) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };
    if (record.secretary_id !== ctx.user.telegram_id) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

    ctx.secretary!.secretaryRepo.updateStatus(record.id, 'revoked');

    const secName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
    const secHandle = ctx.user.username ? ` (@${ctx.user.username})` : '';
    const ownerUser = ctx.userRepo!.findByTelegramId(record.owner_id);
    if (ownerUser && ctx.sender) {
      sendSecretaryNotification(
        ctx,
        record.owner_id,
        ownerUser.username,
        `${secName}${secHandle} добровольно покинул роль секретаря твоего календаря.`,
      ).catch((err: unknown) => secretaryLogger.error({ err }, 'failed to send self_remove notification'));
    }
    return { success: true, output: JSON.stringify({ ok: true }) };
  }

  return { success: false, error: `Unknown action: ${(input as { action: string }).action}` };
}

export function handleListCalendarAccess(ctx: AgentContext): ToolResult {
  if (!ctx.secretary || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };

  const secretaryForRecords = ctx.secretary!.secretaryRepo.getActiveSecretaryFor(ctx.user.telegram_id);
  const mySecretaryRecords = ctx.secretary!.secretaryRepo.getSecretariesForOwner(ctx.user.telegram_id);

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
