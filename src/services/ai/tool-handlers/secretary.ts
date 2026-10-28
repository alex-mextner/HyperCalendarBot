import { InlineKeyboard } from 'gramio';
import type { SecretaryRepository } from '../../../database/repositories/secretary.repository.ts';
import type { CalendarSecretary } from '../../../database/types.ts';
import { botLogger } from '../../../utils/logger.ts';
import { deliverMessage } from '../deliver-message.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';

const secretaryLogger = botLogger.child({ module: 'secretary' });

const MAX_ACTIVE_SECRETARIES = 10;

interface ManageSecretariesInput {
  action: 'invite' | 'revoke' | 'self_remove';
  secretary_telegram_id?: number;
  permission?: 'read' | 'write';
  secretary_access_id?: number;
}

/** "Name (@handle)" label of the calling user as shown in secretary messages. */
function describeCaller(ctx: AgentContext): string {
  const name = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  const handle = ctx.user.username ? ` (@${ctx.user.username})` : '';
  return `${name}${handle}`;
}

async function sendSecretaryInvite(
  ctx: AgentContext,
  record: CalendarSecretary,
  secretaryUser: { telegram_id: number; username?: string | null; first_name?: string | null },
): Promise<void> {
  if (!ctx.sender) return;

  const permLabel = record.permission === 'write' ? 'читать и редактировать' : 'только просматривать';
  const text =
    `${describeCaller(ctx)} хочет добавить тебя секретарём своего календаря.\n` +
    `Права доступа: ${permLabel}.\n\n` +
    `Принять приглашение?`;

  const keyboard = new InlineKeyboard()
    .text('✅ Принять', `sec:accept:${record.id}`)
    .text('❌ Отклонить', `sec:decline:${record.id}`);

  const sender = ctx.sender;

  const result = await deliverMessage({
    targetId: secretaryUser.telegram_id,
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
  });

  if (result.messageId) {
    ctx.secretary!.secretaryRepo.setDmMessageId(record.id, result.messageId);
  }
}

async function sendSecretaryNotification(ctx: AgentContext, targetId: number, text: string): Promise<void> {
  if (!ctx.sender) return;
  await deliverMessage({
    targetId,
    text,
    fallbackRecipientId: ctx.user.telegram_id,
    fallbackText: text,
    botSend: async (id, msg) => {
      const sent = await ctx.sender!.sendMessage(id, msg);
      return { message_id: sent.message_id };
    },
  });
}

/** Notify `targetId` about an already-committed status change; delivery failures are logged, never surfaced. */
async function notifyAfterCommit(ctx: AgentContext, targetId: number, text: string, failureLog: string): Promise<void> {
  const targetUser = ctx.userRepo.findByTelegramId(targetId);
  if (!targetUser || !ctx.sender) return;
  try {
    await sendSecretaryNotification(ctx, targetId, text);
  } catch (err) {
    secretaryLogger.error({ err }, failureLog);
  }
}

async function inviteSecretary(
  ctx: AgentContext,
  secretaryRepo: SecretaryRepository,
  input: ManageSecretariesInput,
): Promise<ToolResult> {
  const { secretary_telegram_id, permission } = input;
  if (!secretary_telegram_id || !permission)
    return { success: false, error: 'secretary_telegram_id and permission required for invite.' };

  const secretaryUser = ctx.userRepo.findByTelegramId(secretary_telegram_id);
  if (!secretaryUser) return { success: false, error: 'SECRETARY_NOT_FOUND' };

  if (secretaryRepo.countActive(ctx.user.telegram_id) >= MAX_ACTIVE_SECRETARIES)
    return { success: false, error: 'SECRETARY_LIMIT_REACHED' };

  const record = secretaryRepo.upsert({
    owner_id: ctx.user.telegram_id,
    secretary_id: secretary_telegram_id,
    permission,
  });

  try {
    await sendSecretaryInvite(ctx, record, secretaryUser);
  } catch (err) {
    secretaryLogger.error({ err, recordId: record.id }, 'Failed to send secretary invite');
    return {
      success: false,
      error: 'SECRETARY_INVITE_DELIVERY_FAILED',
      output: JSON.stringify({ status: 'delivery_failed', secretary_access_id: record.id }),
    };
  }

  return {
    success: true,
    output: JSON.stringify({ status: 'awaiting_confirmation', secretary_access_id: record.id }),
  };
}

async function revokeSecretary(
  ctx: AgentContext,
  secretaryRepo: SecretaryRepository,
  input: ManageSecretariesInput,
): Promise<ToolResult> {
  if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for revoke.' };
  const record = secretaryRepo.findById(input.secretary_access_id);
  if (!record || record.owner_id !== ctx.user.telegram_id) return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

  secretaryRepo.updateStatus(record.id, 'revoked');

  await notifyAfterCommit(
    ctx,
    record.secretary_id,
    `Твой доступ к календарю ${describeCaller(ctx)} был отозван.`,
    'failed to send revoke notification',
  );
  return { success: true, output: JSON.stringify({ ok: true }) };
}

async function selfRemoveSecretary(
  ctx: AgentContext,
  secretaryRepo: SecretaryRepository,
  input: ManageSecretariesInput,
): Promise<ToolResult> {
  if (!input.secretary_access_id) return { success: false, error: 'secretary_access_id required for self_remove.' };
  const record = secretaryRepo.findById(input.secretary_access_id);
  if (!record || record.secretary_id !== ctx.user.telegram_id)
    return { success: false, error: 'SECRETARY_ACCESS_DENIED' };

  secretaryRepo.updateStatus(record.id, 'revoked');

  await notifyAfterCommit(
    ctx,
    record.owner_id,
    `${describeCaller(ctx)} добровольно покинул роль секретаря твоего календаря.`,
    'failed to send self_remove notification',
  );
  return { success: true, output: JSON.stringify({ ok: true }) };
}

export async function handleManageSecretaries(ctx: AgentContext, input: ManageSecretariesInput): Promise<ToolResult> {
  if (!ctx.secretary || !ctx.userRepo) return { success: false, error: 'Secretary feature not configured.' };
  const { secretaryRepo } = ctx.secretary;
  // Widened up front: the tool schema is model-supplied, so an out-of-union action must still be reported by name.
  const action: string = input.action;

  switch (input.action) {
    case 'invite':
      return inviteSecretary(ctx, secretaryRepo, input);
    case 'revoke':
      return revokeSecretary(ctx, secretaryRepo, input);
    case 'self_remove':
      return selfRemoveSecretary(ctx, secretaryRepo, input);
    default:
      return { success: false, error: `Unknown action: ${action}` };
  }
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
handleListCalendarAccess.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
