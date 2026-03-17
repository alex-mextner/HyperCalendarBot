import { logger } from '../../../utils/logger.ts';
import { renderDayImage } from '../../image/render-day.ts';
import { localTimeToUtcHHMM } from '../../notification/timezone.ts';
import type { AgentContext, ToolResult } from '../types.ts';

const metaLogger = logger.child({ module: 'ai-tools' });

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

export function handleAddContact(
  ctx: AgentContext,
  input: { name: string; username?: string; preferred_name?: string },
): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  let telegramId: number | undefined;
  if (input.username) {
    const user = ctx.userRepo.findByUsername(input.username);
    if (user) telegramId = user.telegram_id;
  }
  const contact = ctx.contactRepo.upsert(
    ctx.user.telegram_id,
    input.name,
    input.username,
    telegramId,
    input.preferred_name,
  );
  return {
    success: true,
    output: `Contact saved: "${contact.preferred_name ?? contact.name}"${contact.username ? ` (@${contact.username})` : ''}`,
  };
}

export function handleFindContact(ctx: AgentContext, input: { name: string }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const query = input.name;
  const userId = ctx.user.telegram_id;
  const contact = query.startsWith('@')
    ? (ctx.contactRepo.findByUsername(userId, query) ?? ctx.contactRepo.findByName(userId, query.slice(1)))
    : (ctx.contactRepo.findByName(userId, query) ?? ctx.contactRepo.findByUsername(userId, query));
  if (!contact) return { success: false, error: `No contact named "${input.name}" in address book.` };
  const parts = [`name: ${contact.name}`];
  if (contact.preferred_name) parts.push(`preferred_name: ${contact.preferred_name}`);
  if (contact.username) parts.push(`username: @${contact.username}`);
  if (contact.telegram_id) parts.push(`telegram_id: ${contact.telegram_id}`);
  return { success: true, output: parts.join(', ') };
}

export function handleAskUser(ctx: AgentContext, input: { question: string; options: string[] }): ToolResult {
  if (!ctx.sender?.sendButtons) {
    return { success: false, error: 'Buttons not supported.' };
  }
  const CANCEL = 'Отмена';
  const options = input.options.some((o) => o === CANCEL) ? input.options : [...input.options, CANCEL];
  ctx.sender.sendButtons(ctx.chatId, input.question, options, 'HTML').catch(() => {});
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
  if (input.morning_agenda_time !== undefined) {
    patch.morning_agenda_time = input.morning_agenda_time;
    patch.morning_agenda_utc = localTimeToUtcHHMM(input.morning_agenda_time as string, ctx.user.timezone);
  }
  if (input.evening_review_enabled !== undefined) patch.evening_review_enabled = input.evening_review_enabled ? 1 : 0;
  if (input.evening_review_time !== undefined) {
    patch.evening_review_time = input.evening_review_time;
    patch.evening_review_utc = localTimeToUtcHHMM(input.evening_review_time as string, ctx.user.timezone);
  }
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
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: callQueue not available');
    return {
      success: false,
      error: 'Voice calls are temporarily unavailable. This is a server-side issue, not a user setting problem.',
    };
  }
  metaLogger.info({ userId: ctx.user.telegram_id, textLen: input.text.length }, 'make_call: enqueueing call');
  ctx.callQueue.enqueue(ctx.user.telegram_id, input.text);
  return { success: true, output: 'Call queued. The user will receive a voice call shortly.' };
}

export function handleGetCallSettings(ctx: AgentContext): ToolResult {
  if (!ctx.callSettingsRepo) return { success: false, error: 'Call settings not available.' };
  ctx.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  const settings = ctx.callSettingsRepo.get(ctx.user.telegram_id);
  if (!settings) return { success: true, output: 'No call settings found.' };
  const lines = Object.entries(settings)
    .filter(([k]) => k !== 'user_id' && k !== 'updated_at')
    .map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: lines.join('\n') };
}

export function handleUpdateCallSettings(
  ctx: AgentContext,
  input: { enabled?: boolean; language?: string },
): ToolResult {
  if (!ctx.callSettingsRepo) return { success: false, error: 'Call settings not available.' };
  ctx.callSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  if (input.enabled !== undefined) ctx.callSettingsRepo.setEnabled(ctx.user.telegram_id, input.enabled);
  if (input.language !== undefined) ctx.callSettingsRepo.setLanguage(ctx.user.telegram_id, input.language);
  return { success: true, output: `Call settings updated.` };
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

export function handleGetGoogleCalendarStatus(ctx: AgentContext): ToolResult {
  const connected = !!ctx.user.google_refresh_token_enc;
  if (!connected) {
    return {
      success: true,
      output: 'Google Calendar is NOT connected. The user can connect it with /connect_google command.',
    };
  }

  if (!ctx.googleCalendarRepo) {
    return { success: true, output: 'Google Calendar is connected, but calendar data is not available.' };
  }

  const calendars = ctx.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  const enabled = calendars.filter((c) => c.sync_enabled);
  const lines = ['Google Calendar is connected.', `Calendars: ${calendars.length} total, ${enabled.length} syncing.`];
  for (const cal of calendars) {
    lines.push(`  ${cal.sync_enabled ? '✅' : '⬜'} ${cal.calendar_name} (${cal.google_calendar_id})`);
  }
  return { success: true, output: lines.join('\n') };
}

export function handleListGoogleCalendars(ctx: AgentContext): ToolResult {
  if (!ctx.user.google_refresh_token_enc) {
    return {
      success: false,
      error: 'Google Calendar is not connected. Suggest /connect_google command.',
    };
  }
  if (!ctx.googleCalendarRepo) {
    return { success: false, error: 'Calendar data not available.' };
  }

  const calendars = ctx.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  if (calendars.length === 0) {
    return { success: true, output: 'No Google Calendars found. Sync may still be in progress.' };
  }

  const lines = calendars.map((c) => `${c.sync_enabled ? '✅' : '⬜'} ${c.calendar_name} (${c.google_calendar_id})`);
  return { success: true, output: `Google Calendars:\n${lines.join('\n')}` };
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

export function handleLookupStress(ctx: AgentContext, input: { words: string[] }): ToolResult {
  if (!ctx.stressDictionary) {
    return { success: false, error: 'Stress dictionary not loaded' };
  }

  const results = ctx.stressDictionary.lookupMany(input.words);
  const lines: string[] = [];

  for (const [word, { stressed, similar }] of Object.entries(results)) {
    if (stressed) {
      lines.push(`${word} → ${stressed}`);
    } else {
      let line = `${word} → NOT FOUND`;
      if (similar.length > 0) {
        line += ` | similar: ${similar.join(', ')}`;
      }
      lines.push(line);
    }
  }

  return { success: true, output: lines.join('\n') };
}
