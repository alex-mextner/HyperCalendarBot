import cityTimezones from 'city-timezones';
import { addMonths, addYears, subMonths, subYears } from 'date-fns';
import { t } from '../../../config/constants.ts';
import { autoPin } from '../../../utils/auto-pin.ts';
import { getDayRangeUtc } from '../../../utils/date.ts';
import { logger } from '../../../utils/logger.ts';
import { getTheme } from '../../../worker/templates/themes.ts';
import { renderDayImage } from '../../image/render-day.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

type Scope = 'personal' | 'group';

const metaLogger = logger.child({ module: 'ai-tools' });

interface FindUserInput {
  username: string;
}

interface GetHolidaysInput {
  limit?: number;
}

function getOffsetMinutes(timezone: string, dt: Date): number {
  try {
    return validateAndGetOffset(timezone, dt).offsetMinutes;
  } catch {
    return 0;
  }
}

export function getTimezoneSuggestions(input: string): string[] {
  const prefix = input.includes('/') ? input.split('/')[0] : null;
  const cities = prefix
    ? cityTimezones.cityMapping.filter((c) => c.timezone?.startsWith(`${prefix}/`))
    : cityTimezones.cityMapping;

  const best = new Map<string, { city: string; pop: number }>();
  for (const c of cities) {
    if (!c.timezone) continue;
    const existing = best.get(c.timezone);
    if (!existing || (c.pop ?? 0) > existing.pop) {
      best.set(c.timezone, { city: c.city, pop: c.pop ?? 0 });
    }
  }

  return [...best.entries()]
    .sort(([, a], [, b]) => b.pop - a.pop)
    .slice(0, 30)
    .map(([tz, { city }]) => `${tz} (${city})`);
}

export function validateAndGetOffset(timezone: string, dt: Date): { offsetStr: string; offsetMinutes: number } {
  // throws if timezone is invalid
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'longOffset' });
  const parts = formatter.formatToParts(dt);
  const raw = (parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0').replace(/^GMT/, '');
  const match = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  const offsetStr = match ? `${match[1]}${match[2]!.padStart(2, '0')}:${match[3]}` : '+00:00';
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (Number.parseInt(match[2]!, 10) * 60 + Number.parseInt(match[3]!, 10))
    : 0;
  return { offsetStr, offsetMinutes };
}

function resolveSingle(
  timezone: string,
  dt: Date,
): { offsetStr: string; offsetMinutes: number; dstActive: boolean; localTime: string } {
  const { offsetStr, offsetMinutes } = validateAndGetOffset(timezone, dt); // throws if invalid
  const year = dt.getUTCFullYear();
  const janOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 0, 15)));
  const julOffset = getOffsetMinutes(timezone, new Date(Date.UTC(year, 6, 15)));
  const dstActive = janOffset !== julOffset && offsetMinutes === Math.max(janOffset, julOffset);
  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localTime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;
  return { offsetStr, offsetMinutes, dstActive, localTime };
}

function invalidTimezoneError(tz: string): ToolResult {
  const suggestions = getTimezoneSuggestions(tz);
  const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
  if (!tz.includes('/')) {
    return { success: false, error: `Invalid timezone "${tz}". Use IANA format, e.g. "America/New_York".${hint}` };
  }
  return { success: false, error: `Invalid timezone "${tz}". Check the region name.${hint}` };
}

export function handleGetTimezoneInfo(input: { timezone: string | string[]; at?: string }): ToolResult {
  const dt = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.at}` };
  }

  // Single timezone
  if (typeof input.timezone === 'string') {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(input.timezone, dt);
      return {
        success: true,
        output: JSON.stringify({
          timezone: input.timezone,
          utc_offset: offsetStr,
          utc_offset_minutes: offsetMinutes,
          dst_active: dstActive,
          local_time: localTime,
        }),
      };
    } catch {
      return invalidTimezoneError(input.timezone);
    }
  }

  // Array of timezones
  const entries: Array<{
    timezone: string;
    utc_offset: string;
    utc_offset_minutes: number;
    dst_active: boolean;
    local_time: string;
  }> = [];
  for (const tz of input.timezone) {
    try {
      const { offsetStr, offsetMinutes, dstActive, localTime } = resolveSingle(tz, dt);
      entries.push({
        timezone: tz,
        utc_offset: offsetStr,
        utc_offset_minutes: offsetMinutes,
        dst_active: dstActive,
        local_time: localTime,
      });
    } catch {
      return invalidTimezoneError(tz);
    }
  }

  // Sort west→east by offset
  entries.sort((a, b) => a.utc_offset_minutes - b.utc_offset_minutes);

  const minOffset = entries[0]!.utc_offset_minutes;
  const maxOffset = entries[entries.length - 1]!.utc_offset_minutes;
  const diffMinutes = maxOffset - minOffset;
  const diffHours = Math.round((diffMinutes / 60) * 10) / 10;

  const mostWest = entries[0]!.timezone;
  const mostEast = entries[entries.length - 1]!.timezone;
  const isTwo = entries.length === 2;
  const ahead = isTwo
    ? `${mostEast} is ${diffHours}h ahead of ${mostWest}`
    : `Ranked west→east: ${entries.map((e) => `${e.timezone} (${e.utc_offset})`).join(', ')}. ${mostEast} is furthest ahead.`;

  const result: Record<string, unknown> = { timezones: entries, ahead };
  if (isTwo) {
    result.difference_minutes = diffMinutes;
    result.difference_hours = diffHours;
  }

  return { success: true, output: JSON.stringify(result) };
}

export function handleConvertToTimezone(input: { datetime: string; timezone: string }): ToolResult {
  const dt = new Date(input.datetime);
  if (Number.isNaN(dt.getTime())) {
    return { success: false, error: `Invalid datetime: ${input.datetime}` };
  }

  let offsetStr: string;
  let offsetMinutes: number;
  try {
    ({ offsetStr, offsetMinutes } = validateAndGetOffset(input.timezone, dt));
  } catch {
    const suggestions = getTimezoneSuggestions(input.timezone);
    const hint = suggestions.length > 0 ? `\nLargest cities in this region: ${suggestions.join(', ')}` : '';
    if (!input.timezone.includes('/')) {
      return {
        success: false,
        error: `Invalid timezone "${input.timezone}". Use IANA format, e.g. "America/New_York".${hint}`,
      };
    }
    return { success: false, error: `Invalid timezone "${input.timezone}".${hint}` };
  }

  const localMs = dt.getTime() + offsetMinutes * 60_000;
  const local = new Date(localMs);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const localDatetime =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;

  return {
    success: true,
    output: JSON.stringify({
      timezone: input.timezone,
      local_datetime: localDatetime,
      utc_offset: offsetStr,
    }),
  };
}

export function handleGetHolidays(ctx: AgentContext, input: GetHolidaysInput): ToolResult {
  const holidays = ctx.holidayService.getUpcomingHolidays(ctx.user.telegram_id, input.limit ?? 10);

  if (holidays.length === 0) {
    return { success: true, output: t(ctx.user.language).aiTools.meta.noHolidays };
  }

  const lines = holidays.map((h) => `${h.date}: ${h.name} (${h.countryName})`);

  return { success: true, output: t(ctx.user.language).aiTools.meta.holidaysList(lines.join('\n')) };
}

export async function handleFindUser(ctx: AgentContext, input: FindUserInput): Promise<ToolResult> {
  const username = input.username.replace(/^@/, '');
  const user = ctx.userRepo.findByUsername(username);
  const lang = ctx.user.language;
  const unknownName = t(lang).aiTools.meta.unknownName;
  if (user) {
    const name = user.first_name ?? user.username ?? unknownName;
    return {
      success: true,
      output: t(lang).aiTools.meta.foundUser(user.telegram_id, name),
      data: { telegram_id: user.telegram_id, name },
    };
  }

  if (ctx.resolveUsername) {
    const resolved = await ctx.resolveUsername(username);
    if (resolved) {
      const name = resolved.firstName ?? resolved.username ?? unknownName;
      return {
        success: true,
        output: t(lang).aiTools.meta.foundUserMtproto(resolved.id, name),
        data: { telegram_id: resolved.id, name },
      };
    }
  }

  return {
    success: false,
    error: `User @${username} not found. They may not have used this bot yet.`,
  };
}

export function handleGetContacts(ctx: AgentContext, input: { force?: boolean }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup && !input.force) {
    return {
      success: false,
      error:
        "get_contacts exposes the user's private contact list. In a group this would reveal personal data to all members. Use ask_user to clarify what the user wants first. Only call get_contacts with force: true after the user explicitly confirmed they want their private contacts shown in the group.",
    };
  }
  const contacts = ctx.contactRepo.list(ctx.user.telegram_id);
  const lang = ctx.user.language;
  if (contacts.length === 0) return { success: true, output: t(lang).aiTools.meta.addressBookEmpty };
  const lines = contacts.map((c) => {
    const parts = [c.preferred_name ?? c.name];
    if (c.preferred_name) parts.push(`display:${c.name}`);
    if (c.username) parts.push(`@${c.username}`);
    if (c.telegram_id) parts.push(`id:${c.telegram_id}`);
    return parts.join(' — ');
  });
  return { success: true, output: t(lang).aiTools.meta.contactsList(lines.join('\n')) };
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
  const savedName = `"${contact.preferred_name ?? contact.name}"${contact.username ? ` (@${contact.username})` : ''}`;
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactSaved(savedName) };
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
  const data = parts.join(', ');
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactFound(data) };
}

export function handleUpdateContact(
  ctx: AgentContext,
  input: { search: string; name?: string; preferred_name?: string; username?: string },
): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const userId = ctx.user.telegram_id;
  const query = input.search;
  const contact = query.startsWith('@')
    ? (ctx.contactRepo.findByUsername(userId, query) ?? ctx.contactRepo.findByName(userId, query.slice(1)))
    : (ctx.contactRepo.findByName(userId, query) ?? ctx.contactRepo.findByUsername(userId, query));
  if (!contact) return { success: false, error: `No contact named "${input.search}" in address book.` };
  const patch: { name?: string; preferred_name?: string; username?: string } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.preferred_name !== undefined) patch.preferred_name = input.preferred_name;
  if (input.username !== undefined) patch.username = input.username;
  if (Object.keys(patch).length === 0) return { success: false, error: 'No fields to update provided.' };
  ctx.contactRepo.update(contact.id, patch);
  const updatedName = patch.name ?? contact.name;
  const updated = ctx.contactRepo.findByName(userId, updatedName);
  const displayName = updated?.preferred_name ?? updated?.name ?? updatedName;
  const updatedLabel = `"${displayName}"${updated?.username ? ` (@${updated.username})` : ''}`;
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactUpdated(updatedLabel) };
}

export function handleAskUser(ctx: AgentContext, input: { question: string; options: string[] }): ToolResult {
  if (ctx.inputMode === 'live_call') {
    // During a call, no buttons — speak the question with options as numbered list
    const optionText = input.options.map((o, i) => `${i + 1}. ${o}`).join(', ');
    return {
      success: true,
      output: `${input.question} Options: ${optionText}`,
      stopLoop: true,
    };
  }
  if (!ctx.sender?.sendButtons) {
    return { success: false, error: 'Buttons not supported.' };
  }
  const CANCEL = 'Отмена';
  const options = input.options.some((o) => o === CANCEL) ? input.options : [...input.options, CANCEL];
  const userId = ctx.isGroup ? ctx.user.telegram_id : undefined;
  ctx.sender.sendButtons(ctx.chatId, input.question, options, 'HTML', userId).catch((err) => {
    metaLogger.error({ err }, 'Failed to send buttons');
  });
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.questionSent,
    stopLoop: true,
  };
}

export function handlePickUsers(ctx: AgentContext, input: { event_id: number; prompt: string }): ToolResult {
  if (!ctx.sender?.sendUserPicker) {
    return { success: false, error: 'User picker not supported.' };
  }
  // Use event_id as request_id so we can match the response
  ctx.sender.sendUserPicker(ctx.chatId, input.prompt, input.event_id).catch((err) => {
    metaLogger.error({ err }, 'Failed to send user picker');
  });
  return { success: true, output: t(ctx.user.language).aiTools.meta.userPickerSent, stopLoop: true };
}

export function handleRenderDayImage(
  ctx: AgentContext,
  input: { date: string; scope?: Scope; owner_id?: number },
): ToolResult {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const dateObj = new Date(`${input.date}T12:00:00Z`);
  const occurrences =
    scope === 'group'
      ? (() => {
          const { start, end } = getDayRangeUtc(dateObj, ctx.user.timezone);
          return ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, start, end);
        })()
      : ctx.eventService.getEventsForDay(userId, dateObj, ctx.user.timezone);
  const holidays = ctx.holidayService?.getHolidaysForDate(userId, input.date) ?? [];
  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const sender = ctx.sender;

  const chatId = ctx.chatId;
  const isGroupChat = ctx.isGroup;
  const groupChatRepo = ctx.groupChatRepo;

  renderDayImage(ctx.renderService, occurrences, input.date, ctx.user.timezone, lang, userId, holidays)
    .then(async (buffer) => {
      const file = new File([buffer], 'day.png', { type: 'image/png' });
      const sent = await sender.sendPhoto!(chatId, file);
      autoPin(chatId, sent.message_id, {
        pinChatMessage: (cId, mId, opts) => sender.pinChatMessage?.(cId, mId, opts) ?? Promise.resolve(),
        sendMessage: (cId, text) => sender.sendMessage(cId, text),
        isGroupChat,
        groupChatRepo,
      }).catch((err) => {
        metaLogger.error({ err }, 'autoPin failed');
      });
    })
    .catch((err) => {
      metaLogger.error({ err }, 'Day image render failed');
    });

  return { success: true, output: t(lang).aiTools.meta.dayImageRendering(input.date) };
}

export function handleRenderTable(
  ctx: AgentContext,
  input: { title: string; markdown: string; caption?: string },
): ToolResult {
  if (!ctx.renderService || !ctx.sender?.sendPhoto) {
    return { success: false, error: 'Image rendering not available.' };
  }

  const lang = (ctx.user.language ?? 'en') as 'ru' | 'en';
  const tr = t(lang).aiTools.meta;
  const sender = ctx.sender;
  const chatId = ctx.chatId;
  const isGroupChat = ctx.isGroup;
  const groupChatRepo = ctx.groupChatRepo;

  ctx.renderService
    .renderDirect({
      type: 'md-table',
      data: {
        title: input.title,
        markdown: input.markdown,
        caption: input.caption,
        theme: getTheme(),
      },
      userId: ctx.user.telegram_id,
    })
    .then(async (buffer) => {
      const file = new File([buffer], 'table.png', { type: 'image/png' });
      const sent = await sender.sendPhoto!(chatId, file);
      autoPin(chatId, sent.message_id, {
        pinChatMessage: (cId, mId, opts) => sender.pinChatMessage?.(cId, mId, opts) ?? Promise.resolve(),
        sendMessage: (cId, text) => sender.sendMessage(cId, text),
        isGroupChat,
        groupChatRepo,
      }).catch((err) => {
        metaLogger.error({ err }, 'autoPin failed');
      });
    })
    .catch((err) => {
      metaLogger.error({ err }, 'Table image render failed');
    });

  const voiceNote = ctx.inputMode === 'live_call' ? ` ${tr.tableRenderingVoice}` : '';

  return {
    success: true,
    output: `${tr.tableRendering(input.title)}${voiceNote}`,
  };
}

export function handleRenderWeekImage(
  ctx: AgentContext,
  input: { week_start: string; scope?: Scope; owner_id?: number },
): ToolResult {
  if (!ctx.renderService) {
    return { success: false, error: 'Image rendering not available.' };
  }
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  return { success: true, output: t(ctx.user.language).aiTools.meta.weekImageNotImplemented(input.week_start) };
}

export function handleEndConversation(): ToolResult {
  return {
    success: true,
    stopLoop: true,
    output: 'Conversation marked as complete. The next message will start a fresh context.',
  };
}

export function handleEndCall(ctx: AgentContext): ToolResult {
  if (ctx.inputMode !== 'live_call') {
    return { success: false, error: 'end_call is only available during a live phone call.' };
  }
  ctx.callEndRequested = true;
  return { success: true, output: 'Call will end after the current response is spoken.' };
}

export function handleMakeCall(ctx: AgentContext, input: { text: string }): ToolResult {
  if (ctx.inputMode === 'live_call') {
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: attempted during live call, blocked');
    return {
      success: false,
      error: 'Cannot schedule a call while already on a live call. Just respond to the user directly.',
    };
  }
  if (!ctx.callQueue) {
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: callQueue not available');
    return {
      success: false,
      error: 'Voice calls are temporarily unavailable. This is a server-side issue, not a user setting problem.',
    };
  }
  metaLogger.info({ userId: ctx.user.telegram_id, textLen: input.text.length }, 'make_call: enqueueing call');
  ctx.callQueue.enqueue(ctx.user.telegram_id, input.text);
  return { success: true, output: t(ctx.user.language).aiTools.meta.callQueued };
}

export function handleGetGoogleCalendarStatus(ctx: AgentContext): ToolResult {
  const connected = !!ctx.user.google_refresh_token_enc;
  const lang = ctx.user.language;
  if (!connected) {
    return { success: true, output: t(lang).aiTools.meta.gcalNotConnected };
  }

  if (!ctx.googleCalendarRepo) {
    return { success: true, output: t(lang).aiTools.meta.gcalConnectedNoData };
  }

  const calendars = ctx.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  const enabled = calendars.filter((c) => c.sync_enabled);
  const tr = t(lang).aiTools.meta;
  const lines = [tr.gcalConnectedHeader, tr.gcalCalendarsCount(calendars.length, enabled.length)];
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

  const lang = ctx.user.language;
  const calendars = ctx.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  if (calendars.length === 0) {
    return { success: true, output: t(lang).aiTools.meta.gcalNoCalendars };
  }

  const lines = calendars.map((c) => `${c.sync_enabled ? '✅' : '⬜'} ${c.calendar_name} (${c.google_calendar_id})`);
  return { success: true, output: t(lang).aiTools.meta.gcalList(lines.join('\n')) };
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

function evalArithmetic(expr: string): number {
  let pos = 0;

  function skipWs(): void {
    while (pos < expr.length && expr[pos] === ' ') pos++;
  }

  function parseNumber(): number {
    skipWs();
    const start = pos;
    if (expr[pos] === '-') pos++;
    while (pos < expr.length && /[\d.]/.test(expr[pos]!)) pos++;
    const n = Number(expr.slice(start, pos));
    if (Number.isNaN(n)) throw new Error(`Invalid number at position ${start}`);
    return n;
  }

  function parseFactor(): number {
    skipWs();
    if (expr[pos] === '(') {
      pos++;
      const val = parseAddSub();
      skipWs();
      if (expr[pos] !== ')') throw new Error('Expected )');
      pos++;
      return val;
    }
    return parseNumber();
  }

  function parseMulDiv(): number {
    let left = parseFactor();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '*' && op !== '/') break;
      pos++;
      const right = parseFactor();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseAddSub(): number {
    let left = parseMulDiv();
    while (true) {
      skipWs();
      const op = expr[pos];
      if (op !== '+' && op !== '-') break;
      pos++;
      const right = parseMulDiv();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  const result = parseAddSub();
  skipWs();
  if (pos !== expr.length) throw new Error(`Unexpected character at position ${pos}: ${expr[pos]}`);
  return result;
}

const ISO_DT_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?';
const DURATION_UNITS = 'min|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|months?|y|years?';

function formatDiffMs(absMs: number): string {
  const totalMin = Math.round(absMs / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h < 24) return min === 0 ? `${h}h` : `${h}h ${min}min`;
  const days = Math.floor(h / 24);
  const remH = h % 24;
  const dayLabel = days === 1 ? 'day' : 'days';
  return remH === 0 ? `${days} ${dayLabel}` : `${days} ${dayLabel} ${remH}h`;
}

export function handleCalculate(input: { expression: string }): ToolResult {
  const expr = input.expression.trim();

  // ISO datetime difference: "2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z"
  const isoDatetimeDiffMatch = expr.match(new RegExp(`^(${ISO_DT_RE})\\s*-\\s*(${ISO_DT_RE})$`));
  if (isoDatetimeDiffMatch) {
    const [, aStr, bStr] = isoDatetimeDiffMatch;
    const a = new Date(aStr!);
    const b = new Date(bStr!);
    if (Number.isNaN(a.getTime())) return { success: false, error: `Cannot parse datetime: ${aStr}` };
    if (Number.isNaN(b.getTime())) return { success: false, error: `Cannot parse datetime: ${bStr}` };
    return { success: true, output: formatDiffMs(Math.abs(a.getTime() - b.getTime())) };
  }

  // Date-only difference: "2026-04-10 - 2026-03-21"
  const dateOnlyDiffMatch = expr.match(/^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/);
  if (dateOnlyDiffMatch) {
    const [, aStr, bStr] = dateOnlyDiffMatch;
    const a = new Date(`${aStr}T12:00:00Z`);
    const b = new Date(`${bStr}T12:00:00Z`);
    if (Number.isNaN(a.getTime())) return { success: false, error: `Cannot parse date: ${aStr}` };
    if (Number.isNaN(b.getTime())) return { success: false, error: `Cannot parse date: ${bStr}` };
    const days = Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
    return { success: true, output: `${days} days` };
  }

  // ISO datetime ± duration: "2026-03-18T22:34:00Z + 31min", "+ 1month", "+ 2weeks"
  const isoDatetimeMatch = expr.match(
    new RegExp(`^(${ISO_DT_RE})\\s*([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNITS})\\b`, 'i'),
  );
  if (isoDatetimeMatch) {
    const [, dateStr, op, amtStr, unit] = isoDatetimeMatch;
    const date = new Date(dateStr!);
    if (Number.isNaN(date.getTime())) return { success: false, error: `Cannot parse datetime: ${dateStr}` };
    const amt = parseFloat(amtStr!);
    const unitL = unit!.toLowerCase();
    if (unitL.startsWith('mo') || unitL.startsWith('month')) {
      const n = Math.trunc(amt);
      const result = op === '+' ? addMonths(date, n) : subMonths(date, n);
      return { success: true, output: result.toISOString() };
    }
    if (unitL === 'y' || unitL.startsWith('year')) {
      const n = Math.trunc(amt);
      const result = op === '+' ? addYears(date, n) : subYears(date, n);
      return { success: true, output: result.toISOString() };
    }
    const sign = op === '+' ? 1 : -1;
    let deltaMs: number;
    if (unitL.startsWith('min')) deltaMs = amt * 60_000;
    else if (unitL === 'h' || unitL.startsWith('hr') || unitL.startsWith('hour')) deltaMs = amt * 3_600_000;
    else if (unitL === 'w' || unitL.startsWith('week')) deltaMs = amt * 7 * 86_400_000;
    else deltaMs = amt * 86_400_000;
    return { success: true, output: new Date(date.getTime() + sign * deltaMs).toISOString() };
  }

  // Date-only ± duration: "2026-03-18 + 7days", "+ 2weeks", "+ 1month"
  const dateOnlyMatch = expr.match(
    new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\s*([+-])\\s*(\\d+)\\s*(${DURATION_UNITS})\\b`, 'i'),
  );
  if (dateOnlyMatch) {
    const [, dateStr, op, amtStr, unit] = dateOnlyMatch;
    const date = new Date(`${dateStr}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return { success: false, error: `Cannot parse date: ${dateStr}` };
    const amt = Number.parseInt(amtStr!, 10);
    const unitL = unit!.toLowerCase();
    if (unitL.startsWith('mo') || unitL.startsWith('month')) {
      const result = op === '+' ? addMonths(date, amt) : subMonths(date, amt);
      return { success: true, output: result.toISOString().slice(0, 10) };
    }
    if (unitL === 'y' || unitL.startsWith('year')) {
      const result = op === '+' ? addYears(date, amt) : subYears(date, amt);
      return { success: true, output: result.toISOString().slice(0, 10) };
    }
    const sign = op === '+' ? 1 : -1;
    const weeks = unitL === 'w' || unitL.startsWith('week') ? 7 : 1;
    const result = new Date(date.getTime() + sign * amt * weeks * 86_400_000);
    return { success: true, output: result.toISOString().slice(0, 10) };
  }

  // HH:MM ± duration: "22:34 + 31min"
  const timeMatch = expr.match(/^(\d{1,2}):(\d{2})\s*([+-])\s*(\d+(?:\.\d+)?)\s*(min|minutes?|h|hr|hours?)\b/i);
  if (timeMatch) {
    const [, h, m, op, amtStr, unit] = timeMatch;
    let totalMin = Number.parseInt(h!, 10) * 60 + Number.parseInt(m!, 10);
    const amt = parseFloat(amtStr!);
    const sign = op === '+' ? 1 : -1;
    if (unit!.toLowerCase().startsWith('min')) totalMin += sign * amt;
    else totalMin += sign * amt * 60;
    totalMin = ((totalMin % 1440) + 1440) % 1440;
    const rh = Math.floor(totalMin / 60)
      .toString()
      .padStart(2, '0');
    const rm = (totalMin % 60).toString().padStart(2, '0');
    return { success: true, output: `${rh}:${rm}` };
  }

  // Numeric arithmetic: digits, whitespace, operators, parentheses only
  if (/^[\d\s+\-*/.()]+$/.test(expr)) {
    try {
      const result = evalArithmetic(expr);
      if (!Number.isFinite(result)) {
        return { success: false, error: 'Result is not a finite number' };
      }
      return { success: true, output: String(result) };
    } catch {
      return { success: false, error: `Cannot evaluate: ${expr}` };
    }
  }

  return {
    success: false,
    error: `Cannot parse: "${expr}". Supported: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime`,
  };
}
