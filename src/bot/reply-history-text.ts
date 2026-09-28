// src/bot/reply-history-text.ts
// The chat_history copy of a bot reply that shows the user something history must not keep: the
// masked phone of a connected Telegram account ('+7 ••• 4567'). The user sees the reply as sent;
// chat history — and so the AI context, its debug log and get_history — keeps the same reply with
// the masked phone replaced (GH-643). Only the replies that name it opt in; nothing else is rewritten.

/** Stands for the masked phone in the history copy of a reply that shows it. */
export const MASKED_PHONE_IN_HISTORY = '[masked phone]';

/** Keyed by the update context whose `send`/`editText` chat logging wraps. */
const historyTexts = new WeakMap<object, Map<string, string>>();

/**
 * Registers `stored` as the chat_history copy of `shown` when this update context sends or edits it,
 * and returns `shown` for the call itself.
 */
export function withHistoryText(context: object, shown: string, stored: string): string {
  const byShown = historyTexts.get(context) ?? new Map<string, string>();
  byShown.set(shown, stored);
  historyTexts.set(context, byShown);
  return shown;
}

/** The chat_history copy of a reply this context sent: its registered copy (used once), else the reply itself. */
export function historyTextOf(context: object, shown: string): string {
  const byShown = historyTexts.get(context);
  const stored = byShown?.get(shown);
  if (stored === undefined) return shown;
  byShown?.delete(shown);
  return stored;
}
