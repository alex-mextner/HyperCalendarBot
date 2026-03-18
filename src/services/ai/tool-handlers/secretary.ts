import type { AgentContext, ToolResult } from '../types.ts';

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
