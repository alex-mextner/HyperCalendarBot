import type { AgentContext, ToolResult } from '../types.ts';

interface GetHolidaysInput {
  limit?: number;
}

interface UpdateUserSettingsInput {
  timezone?: string;
  language?: 'en' | 'ru';
}

export function handleGetHolidays(ctx: AgentContext, input: GetHolidaysInput): ToolResult {
  const holidays = ctx.holidayService.getUpcomingHolidays(ctx.user.telegram_id, input.limit ?? 10);

  if (holidays.length === 0) {
    return {
      success: true,
      output: 'No upcoming holidays. The user may not have country subscriptions.',
    };
  }

  const lines = holidays.map((h) => `${h.date}: ${h.name} (${h.countryName})`);

  return { success: true, output: `Upcoming holidays:\n${lines.join('\n')}` };
}

export function handleGetUserSettings(ctx: AgentContext): ToolResult {
  const u = ctx.user;
  const lines = [
    `timezone: ${u.timezone}`,
    `language: ${u.language}`,
    `username: ${u.username ?? 'not set'}`,
    `first_name: ${u.first_name ?? 'not set'}`,
    `country_code: ${u.country_code ?? 'not set'}`,
  ];
  return { success: true, output: lines.join('\n') };
}

export function handleUpdateUserSettings(ctx: AgentContext, input: UpdateUserSettingsInput): ToolResult {
  const updates: Record<string, string> = {};
  if (input.timezone) updates.timezone = input.timezone;
  if (input.language) updates.language = input.language;

  if (Object.keys(updates).length === 0) {
    return { success: false, error: 'No settings provided to update.' };
  }

  const updated = ctx.userRepo.update(ctx.user.telegram_id, updates);
  if (!updated) {
    return { success: false, error: 'Failed to update user settings.' };
  }

  ctx.user = updated;

  const lines = Object.entries(updates).map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: `Settings updated: ${lines.join(', ')}` };
}
