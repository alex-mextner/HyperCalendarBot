// The user-facing stream writer of one agent turn and the sender it writes through.
import { findWeekdayDateMismatches, mentionsWeekday } from '../day-references.ts';
import { TelegramStreamWriter } from '../telegram-stream.ts';
import type { AgentContext, TelegramSender } from '../types.ts';

/** A sender that delivers nothing: a supplement is optional text and must not reach the chat. */
const SILENT_SENDER: TelegramSender = {
  sendMessage: async () => ({ message_id: 0 }),
  editMessageText: async () => {},
  sendMessageWithKeyboard: async () => ({ message_id: 0 }),
  sendButtons: async () => ({ message_id: 0 }),
  sendUserPicker: async () => ({ message_id: 0 }),
  sendPhoto: async () => ({ message_id: 0 }),
  sendInvitation: async () => null,
  sendEditProposal: async () => null,
  deleteMessage: async () => {},
  setReaction: async () => {},
};

/** The sender a turn writes through: the real one, or a silent one for a supplement. */
export function senderForTurn(ctx: AgentContext, sender: TelegramSender): TelegramSender {
  return ctx.supplementMode ? SILENT_SENDER : sender;
}

/**
 * Whether any argument of a tool call pairs a weekday with a date on another weekday. Each
 * argument is read whole, the way checkQuestionWeekdays reads a question and its options.
 */
export function pairsWeekdayWithOtherDate(
  input: { [key: string]: unknown },
  timezone: string,
  now = new Date(),
): boolean {
  return Object.values(input)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .some((value) => typeof value === 'string' && findWeekdayDateMismatches(value, now, timezone).length > 0);
}

export function createTurnWriter(ctx: AgentContext, sender: TelegramSender): TelegramStreamWriter {
  return new TelegramStreamWriter(sender, ctx.chatId, ctx.user.language, {
    userTranscript: ctx.inputMode === 'live_call' ? ctx.messageText : undefined,
    noPlaceholder: ctx.isGroup,
    // A weekday next to a date is shown only after checkRoundWeekdays() found them consistent.
    holdDraftWhen: mentionsWeekday,
    hideToolDetailsWhen: (input) => pairsWeekdayWithOtherDate(input, ctx.user.timezone),
  });
}
