import { t, toLang } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';

export { handleCalculate } from './calculate.ts';
export { handleAddContact, handleFindContact, handleGetContacts, handleUpdateContact } from './contacts.ts';
export { handleRenderDayImage, handleRenderMonthImage, handleRenderTable, handleRenderWeekImage } from './render.ts';
export {
  getTimezoneSuggestions,
  handleConvertToTimezone,
  handleGetTimezoneInfo,
  validateAndGetOffset,
} from './timezone.ts';

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
    return { success: true, output: t(ctx.user.language).aiTools.meta.noHolidays };
  }

  const lines = holidays.map((h) => `${h.date}: ${h.name} (${h.countryName})`);

  return { success: true, output: t(ctx.user.language).aiTools.meta.holidaysList(lines.join('\n')) };
}
handleGetHolidays.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

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
handleFindUser.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export async function handleAskUser(
  ctx: AgentContext,
  input: { question: string; options: string[] },
): Promise<ToolResult> {
  if (ctx.inputMode === 'live_call') {
    // During a call, no buttons — speak the question with options as numbered list
    const optionText = input.options.map((o, i) => `${i + 1}. ${o}`).join(', ');
    return {
      success: true,
      output: t(toLang(ctx.user.language)).writeOutcomes.spokenQuestion(input.question, optionText),
      awaitingInput: {
        kind: 'speech',
        question: t(toLang(ctx.user.language)).writeOutcomes.spokenQuestion(input.question, optionText),
      },
      stopLoop: true,
    };
  }
  if (!ctx.sender?.sendButtons) {
    return { success: false, error: 'Buttons not supported.' };
  }
  const CANCEL = 'Отмена';
  const options = input.options.some((o) => o === CANCEL) ? input.options : [...input.options, CANCEL];
  const userId = ctx.isGroup ? ctx.user.telegram_id : undefined;
  try {
    await ctx.sender.sendButtons(ctx.chatId, input.question, options, 'HTML', userId);
  } catch (err) {
    metaLogger.error({ err }, 'Failed to send buttons');
    return { success: false, error: 'ASK_USER_DELIVERY_FAILED: failed to send the question to the user.' };
  }
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.questionSent,
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
  };
}
handleAskUser.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

export async function handlePickUsers(
  ctx: AgentContext,
  input: { event_id: number; prompt: string },
): Promise<ToolResult> {
  if (!ctx.sender?.sendUserPicker) {
    return { success: false, error: 'User picker not supported.' };
  }
  try {
    // Use event_id as request_id so we can match the response
    await ctx.sender.sendUserPicker(ctx.chatId, input.prompt, input.event_id);
  } catch (err) {
    metaLogger.error({ err }, 'Failed to send user picker');
    return { success: false, error: 'PICK_USERS_DELIVERY_FAILED: failed to send the user picker.' };
  }
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.userPickerSent,
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
  };
}
handlePickUsers.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

export function handleEndConversation(): ToolResult {
  return {
    success: true,
    stopLoop: true,
    output: 'Conversation marked as complete. The next message will start a fresh context.',
  };
}
handleEndConversation.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

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
  if (!ctx.voice?.callQueue) {
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: callQueue not available');
    return {
      success: false,
      error: 'Voice calls are temporarily unavailable. This is a server-side issue, not a user setting problem.',
    };
  }
  metaLogger.info({ userId: ctx.user.telegram_id, textLen: input.text.length }, 'make_call: enqueueing call');
  ctx.voice!.callQueue.enqueue(ctx.user.telegram_id, input.text);
  return { success: true, output: t(ctx.user.language).aiTools.meta.callQueued };
}

export function handleGetGoogleCalendarStatus(ctx: AgentContext): ToolResult {
  const connected = !!ctx.user.google_refresh_token_enc;
  const lang = ctx.user.language;
  if (!connected) {
    return { success: true, output: t(lang).aiTools.meta.gcalNotConnected };
  }

  if (!ctx.google?.googleCalendarRepo) {
    return { success: true, output: t(lang).aiTools.meta.gcalConnectedNoData };
  }

  const calendars = ctx.google!.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  const enabled = calendars.filter((c) => c.sync_enabled);
  const tr = t(lang).aiTools.meta;
  const lines = [tr.gcalConnectedHeader, tr.gcalCalendarsCount(calendars.length, enabled.length)];
  for (const cal of calendars) {
    lines.push(`  ${cal.sync_enabled ? '✅' : '⬜'} ${cal.calendar_name} (${cal.google_calendar_id})`);
  }
  return { success: true, output: lines.join('\n') };
}
handleGetGoogleCalendarStatus.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleListGoogleCalendars(ctx: AgentContext): ToolResult {
  if (!ctx.user.google_refresh_token_enc) {
    return {
      success: false,
      error: 'Google Calendar is not connected. Suggest /connect_google command.',
    };
  }
  if (!ctx.google?.googleCalendarRepo) {
    return { success: false, error: 'Calendar data not available.' };
  }

  const lang = ctx.user.language;
  const calendars = ctx.google!.googleCalendarRepo.getCalendars(ctx.user.telegram_id);
  if (calendars.length === 0) {
    return { success: true, output: t(lang).aiTools.meta.gcalNoCalendars };
  }

  const lines = calendars.map((c) => `${c.sync_enabled ? '✅' : '⬜'} ${c.calendar_name} (${c.google_calendar_id})`);
  return { success: true, output: t(lang).aiTools.meta.gcalList(lines.join('\n')) };
}
handleListGoogleCalendars.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleLookupStress(ctx: AgentContext, input: { words: string[] }): ToolResult {
  if (!ctx.voice?.stressDictionary) {
    return { success: false, error: 'Stress dictionary not loaded' };
  }

  const results = ctx.voice!.stressDictionary.lookupMany(input.words);
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
handleLookupStress.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

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
handleGetBotInfo.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
