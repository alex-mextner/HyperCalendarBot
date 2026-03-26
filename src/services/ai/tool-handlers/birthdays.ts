import { t } from '../../../config/constants.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface CreateBirthdayInput {
  celebrant_id: number;
  date: { day: number; month: number };
  year?: number;
  custom_name?: string;
  group_id?: number;
}

export function handleCreateBirthdayEvent(ctx: AgentContext, input: CreateBirthdayInput): ToolResult {
  if (!ctx.birthday) return { success: false, error: 'Birthday service unavailable' };
  const { birthdayService } = ctx.birthday;

  const lang = ctx.user.language as 'en' | 'ru';

  // Validate date — day 0, month 0 would produce an invalid ISO date and crash the pipeline
  const { day, month } = input.date;
  if (!day || !month || day < 1 || day > 31 || month < 1 || month > 12) {
    return { success: false, error: 'Invalid date: day must be 1-31, month must be 1-12' };
  }

  // Resolve celebrant name
  let celebrantName = input.custom_name;
  if (!celebrantName) {
    const dbUser = ctx.userRepo.findByTelegramId(input.celebrant_id);
    celebrantName = dbUser?.first_name ?? String(input.celebrant_id);
  }

  // Dedup check for personal calendar
  if (!input.group_id) {
    const existing = birthdayService.findExistingBirthday(input.celebrant_id, ctx.user.telegram_id);
    if (existing) {
      const existingDate = new Date(existing.start_at);
      const existingDay = existingDate.getUTCDate();
      const existingMonth = existingDate.getUTCMonth() + 1;

      if (existingDay === input.date.day && existingMonth === input.date.month) {
        return {
          success: true,
          output: t(lang).aiTools.birthdays.alreadyExists(celebrantName, existingDay, existingMonth),
        };
      }

      return {
        success: false,
        error: t(lang).aiTools.birthdays.conflictError(celebrantName, existingDay, existingMonth),
      };
    }
  }

  birthdayService.upsertBirthdayEvent({
    ownerId: ctx.user.telegram_id,
    celebrantId: input.celebrant_id,
    celebrantName,
    day: input.date.day,
    month: input.date.month,
    year: input.year ?? null,
    lang,
    timezone: ctx.user.timezone,
    autoCreated: false,
    groupId: input.group_id,
  });

  return {
    success: true,
    output: t(lang).aiTools.birthdays.created(celebrantName, input.date.day, input.date.month),
  };
}
