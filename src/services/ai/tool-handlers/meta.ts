import { getDayRangeUtc } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { renderDayImage } from '../../image/render-day.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

const metaLogger = logger.child({ module: 'ai-tools' });

interface FindUserInput {
  username: string;
}

interface GetHolidaysInput {
  limit?: number;
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
  const userId = ctx.isGroup ? ctx.user.telegram_id : undefined;
  ctx.sender.sendButtons(ctx.chatId, input.question, options, 'HTML', userId).catch((err) => {
    metaLogger.error({ error: String(err) }, 'Failed to send buttons');
  });
  return { success: true, output: 'Question sent. Waiting for user response.', stopLoop: true };
}

export function handlePickUsers(ctx: AgentContext, input: { event_id: number; prompt: string }): ToolResult {
  if (!ctx.sender?.sendUserPicker) {
    return { success: false, error: 'User picker not supported.' };
  }
  // Use event_id as request_id so we can match the response
  ctx.sender.sendUserPicker(ctx.chatId, input.prompt, input.event_id).catch((err) => {
    metaLogger.error({ error: String(err) }, 'Failed to send user picker');
  });
  return { success: true, output: 'User picker sent. Waiting for user to select participants.', stopLoop: true };
}

export function handleRenderDayImage(ctx: AgentContext, input: { date: string; scope?: Scope }): ToolResult {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && !ctx.groupChatId) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const dateObj = new Date(`${input.date}T12:00:00Z`);
  const occurrences =
    scope === 'group'
      ? (() => {
          const { start, end } = getDayRangeUtc(dateObj, ctx.user.timezone);
          return ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
        })()
      : ctx.eventService.getEventsForDay(ctx.user.telegram_id, dateObj, ctx.user.timezone);
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
    .catch((err) => {
      metaLogger.error({ error: String(err) }, 'Day image render failed');
    });

  return { success: true, output: `Image for ${input.date} is being rendered and will be sent as a photo.` };
}

export function handleRenderWeekImage(ctx: AgentContext, input: { week_start: string }): ToolResult {
  if (!ctx.renderService) {
    return { success: false, error: 'Image rendering not available.' };
  }
  return { success: true, output: `Week image rendering for ${input.week_start} is not yet implemented via AI tools.` };
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

export function handleGetBotInfo(): ToolResult {
  return {
    success: true,
    output: [
      'Non-obvious capabilities:',
      '- Voice messages: send a voice message and the bot will transcribe and understand it',
      '- Voice responses: enable in settings to receive voice replies (useful while driving, cooking, or on the go)',
      '- Group chats: add the bot to a group with friends to create shared calendars',
      '- feedback: say "found a bug" or "want to suggest a feature" to start a conversation with the developer',
      '- Developer: @mxtnr',
    ].join('\n'),
  };
}
