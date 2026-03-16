import { renderDayImage } from '../../image/render-day.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface FindUserInput {
  username: string;
}

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

export function handleFindUser(ctx: AgentContext, input: FindUserInput): ToolResult {
  const user = ctx.userRepo.findByUsername(input.username);
  if (!user) {
    return {
      success: false,
      error: `User @${input.username.replace(/^@/, '')} not found. They may not have used this bot yet.`,
    };
  }
  return {
    success: true,
    output: `Found user: telegram_id=${user.telegram_id}, name=${user.first_name ?? user.username ?? 'unknown'}`,
  };
}

export function handleGetContacts(ctx: AgentContext): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const contacts = ctx.contactRepo.list(ctx.user.telegram_id);
  if (contacts.length === 0) return { success: true, output: 'Address book is empty.' };
  const lines = contacts.map((c) => {
    const parts = [c.name];
    if (c.username) parts.push(`@${c.username}`);
    if (c.telegram_id) parts.push(`id:${c.telegram_id}`);
    return parts.join(' — ');
  });
  return { success: true, output: `Contacts:\n${lines.join('\n')}` };
}

export function handleAddContact(ctx: AgentContext, input: { name: string; username?: string }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  let telegramId: number | undefined;
  if (input.username) {
    const user = ctx.userRepo.findByUsername(input.username);
    if (user) telegramId = user.telegram_id;
  }
  const contact = ctx.contactRepo.upsert(ctx.user.telegram_id, input.name, input.username, telegramId);
  return {
    success: true,
    output: `Contact saved: "${contact.name}"${contact.username ? ` (@${contact.username})` : ''}`,
  };
}

export function handleFindContact(ctx: AgentContext, input: { name: string }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const contact = ctx.contactRepo.findByName(ctx.user.telegram_id, input.name);
  if (!contact) return { success: false, error: `No contact named "${input.name}" in address book.` };
  const parts = [`name: ${contact.name}`];
  if (contact.username) parts.push(`username: @${contact.username}`);
  if (contact.telegram_id) parts.push(`telegram_id: ${contact.telegram_id}`);
  return { success: true, output: parts.join(', ') };
}

export function handleAskUser(ctx: AgentContext, input: { question: string; options: string[] }): ToolResult {
  if (!ctx.sender?.sendButtons) {
    return { success: false, error: 'Buttons not supported.' };
  }
  ctx.sender.sendButtons(ctx.chatId, input.question, input.options, 'HTML').catch(() => {});
  return { success: true, output: 'Question sent. Waiting for user response.', stopLoop: true };
}

export function handlePickUsers(ctx: AgentContext, input: { event_id: number; prompt: string }): ToolResult {
  if (!ctx.sender?.sendUserPicker) {
    return { success: false, error: 'User picker not supported.' };
  }
  // Use event_id as request_id so we can match the response
  ctx.sender.sendUserPicker(ctx.chatId, input.prompt, input.event_id).catch(() => {});
  return { success: true, output: 'User picker sent. Waiting for user to select participants.', stopLoop: true };
}

export function handleRenderDayImage(ctx: AgentContext, input: { date: string }): ToolResult {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const occurrences = ctx.eventService.getEventsForDay(
    ctx.user.telegram_id,
    new Date(`${input.date}T12:00:00Z`),
    ctx.user.timezone,
  );
  const holidays = ctx.holidayService?.getHolidaysForDate(ctx.user.telegram_id, input.date) ?? [];
  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;

  renderDayImage(
    ctx.renderService as never,
    occurrences,
    input.date,
    ctx.user.timezone,
    lang,
    ctx.user.telegram_id,
    holidays,
  )
    .then((buffer) => {
      const file = new File([buffer], 'day.png', { type: 'image/png' });
      return sender.sendPhoto!(ctx.chatId, file);
    })
    .catch(() => {});

  return { success: true, output: `Image for ${input.date} is being rendered and will be sent as a photo.` };
}

export function handleRenderWeekImage(ctx: AgentContext, input: { week_start: string }): ToolResult {
  if (!ctx.renderService) {
    return { success: false, error: 'Image rendering not available.' };
  }
  return { success: true, output: `Week image rendering for ${input.week_start} is not yet implemented via AI tools.` };
}

export function handleGetNotificationSettings(ctx: AgentContext): ToolResult {
  if (!ctx.notificationPrefs) return { success: false, error: 'Notification settings not configured.' };
  ctx.notificationPrefs.ensureDefaults(ctx.user.telegram_id);
  const prefs = ctx.notificationPrefs.getPrefs(ctx.user.telegram_id);
  const lines = Object.entries(prefs).map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: lines.join('\n') };
}

export function handleUpdateNotificationSettings(ctx: AgentContext, input: Record<string, unknown>): ToolResult {
  if (!ctx.notificationPrefs) return { success: false, error: 'Notification settings not configured.' };
  ctx.notificationPrefs.ensureDefaults(ctx.user.telegram_id);

  const patch: Record<string, unknown> = {};
  if (input.morning_agenda_enabled !== undefined) patch.morning_agenda_enabled = input.morning_agenda_enabled ? 1 : 0;
  if (input.morning_agenda_time !== undefined) patch.morning_agenda_time = input.morning_agenda_time;
  if (input.evening_review_enabled !== undefined) patch.evening_review_enabled = input.evening_review_enabled ? 1 : 0;
  if (input.evening_review_time !== undefined) patch.evening_review_time = input.evening_review_time;
  if (input.quiet_hours_enabled !== undefined) patch.quiet_hours_enabled = input.quiet_hours_enabled ? 1 : 0;
  if (input.quiet_hours_start !== undefined) patch.quiet_hours_start = input.quiet_hours_start;
  if (input.quiet_hours_end !== undefined) patch.quiet_hours_end = input.quiet_hours_end;
  if (input.default_reminder_minutes !== undefined) {
    patch.default_reminder_intervals = JSON.stringify(input.default_reminder_minutes);
  }

  if (Object.keys(patch).length === 0) return { success: false, error: 'No settings provided.' };
  ctx.notificationPrefs.update(ctx.user.telegram_id, patch);
  return { success: true, output: `Notification settings updated: ${Object.keys(patch).join(', ')}` };
}

export function handleMakeCall(ctx: AgentContext, input: { text: string }): ToolResult {
  if (!ctx.callQueue) {
    return {
      success: false,
      error:
        'Voice calls not configured on this server. Suggest the user to enable voice call reminders in /callsettings.',
    };
  }
  ctx.callQueue.enqueue(ctx.user.telegram_id, input.text);
  return { success: true, output: 'Call queued. The user will receive a voice call shortly.' };
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
