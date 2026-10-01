import { t, toLang } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import {
  canResolveRecipientUsername,
  lookUpUsername,
  markVerifiedRecipient,
  normalizeRecipientUsername,
} from '../recipient-identity.ts';
import { correctAskedQuestion, eventClocksForRun } from '../reply-time-guard.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';
import { handleDeleteConfirmationRequest } from './events.ts';

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
  const username = normalizeRecipientUsername(input.username);
  if (!canResolveRecipientUsername(ctx, username) && normalizeRecipientUsername(ctx.user.username ?? '') !== username) {
    return {
      success: false,
      error: t(ctx.user.language).aiTools.meta.recipientUsernameUnconfirmed,
      agentHint:
        'Use find_contact for a personal name. Ask for the exact @username or use pick_users if the person is not in the address book; do not guess.',
    };
  }
  const tr = t(ctx.user.language).aiTools.meta;
  const lookup = await lookUpUsername(ctx, username);
  if (lookup.status === 'found') {
    const { user } = lookup;
    markVerifiedRecipient(ctx, user.id);
    const name = user.firstName ?? user.username;
    return { success: true, output: tr.foundUser(user.id, name), data: { telegram_id: user.id, name } };
  }
  if (lookup.status === 'unverified') return { success: false, error: tr.recipientUnverified };
  if (lookup.status === 'not_found') {
    return {
      success: false,
      error: tr.recipientNotFound(username),
      agentHint: 'Ask the user to check the @username, or offer pick_users.',
    };
  }
  return {
    success: false,
    error: tr.recipientResolveUnavailable,
    agentHint:
      'This does not mean the person does not exist or has not started the bot. Offer pick_users so the user can share the contact from Telegram.',
  };
}
handleFindUser.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export async function handleAskUser(
  ctx: AgentContext,
  input: { question: string; options: string[]; event_ids?: number[] },
): Promise<ToolResult> {
  if (input.event_ids && input.event_ids.length > 0) return handleDeleteConfirmationRequest(ctx, input.event_ids);
  // The question and buttons go to the user verbatim, so the reply-time guard runs here too (#498).
  const { question, options: askedOptions } = correctAskedQuestion(
    input.question,
    input.options,
    eventClocksForRun(ctx),
    ctx.user.timezone,
  );
  const corrected = question !== input.question || askedOptions.some((option, i) => option !== input.options[i]);
  const agentHint = corrected
    ? `Your question showed event times in UTC; the user saw them in local time instead: "${question}" [${askedOptions.join(' | ')}]`
    : undefined;
  if (agentHint)
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'ask_user question showed UTC times as local — corrected');
  if (ctx.inputMode === 'live_call') {
    // During a call, no buttons — speak the question with options as numbered list
    const optionText = askedOptions.map((o, i) => `${i + 1}. ${o}`).join(', ');
    return {
      success: true,
      output: t(toLang(ctx.user.language)).writeOutcomes.spokenQuestion(question, optionText),
      awaitingInput: {
        kind: 'speech',
        question: t(toLang(ctx.user.language)).writeOutcomes.spokenQuestion(question, optionText),
      },
      stopLoop: true,
      agentHint,
    };
  }
  if (!ctx.sender?.sendButtons) {
    return { success: false, error: 'Buttons not supported.' };
  }
  const CANCEL = 'Отмена';
  const options = askedOptions.some((o) => o === CANCEL) ? askedOptions : [...askedOptions, CANCEL];
  const userId = ctx.isGroup ? ctx.user.telegram_id : undefined;
  try {
    await ctx.sender.sendButtons(ctx.chatId, question, options, 'HTML', userId);
  } catch (err) {
    metaLogger.error({ err }, 'Failed to send buttons');
    return { success: false, error: 'ASK_USER_DELIVERY_FAILED: failed to send the question to the user.' };
  }
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.questionSent,
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
    agentHint,
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

export async function handleMakeCall(ctx: AgentContext, input: { text: string }): Promise<ToolResult> {
  if (ctx.inputMode === 'live_call') {
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: attempted during live call, blocked');
    return {
      success: false,
      error: 'Cannot schedule a call while already on a live call. Just respond to the user directly.',
    };
  }
  if (!ctx.calls) {
    metaLogger.warn({ userId: ctx.user.telegram_id }, 'make_call: voice calls are not available');
    return {
      success: false,
      error: t(ctx.user.language).settings.callsUnavailable,
      agentHint:
        'This bot has no calling account, so it cannot call anyone. It is not a setting the user can change; offer a text reminder instead.',
    };
  }
  metaLogger.info({ userId: ctx.user.telegram_id, textLen: input.text.length }, 'make_call: enqueueing call');
  try {
    await ctx.calls.callQueue.enqueue(ctx.user.telegram_id, input.text);
  } catch (error) {
    metaLogger.error({ err: error, userId: ctx.user.telegram_id }, 'make_call: could not queue the call');
    return { success: false, error: t(ctx.user.language).aiTools.meta.callQueueFailed };
  }
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
  if (!ctx.voice) {
    return { success: false, error: 'Stress dictionary not loaded' };
  }

  const results = ctx.voice.stressDictionary.lookupMany(input.words);
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
