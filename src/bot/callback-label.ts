interface CallbackButtonLike {
  text?: unknown;
  callback_data?: unknown;
}

interface ReplyMarkupLike {
  inline_keyboard?: unknown;
}

/** Resolve the user-visible label for a callback, falling back to its action code. */
export function resolveCallbackButtonLabel(replyMarkup: unknown, callbackData: string, fallback: string): string {
  if (!replyMarkup || typeof replyMarkup !== 'object') return fallback;
  const keyboard = (replyMarkup as ReplyMarkupLike).inline_keyboard;
  if (!Array.isArray(keyboard)) return fallback;

  for (const row of keyboard) {
    if (!Array.isArray(row)) continue;
    for (const rawButton of row) {
      if (!rawButton || typeof rawButton !== 'object') continue;
      const button = rawButton as CallbackButtonLike;
      if (button.callback_data !== callbackData || typeof button.text !== 'string') continue;
      const label = button.text.trim();
      if (label) return label;
    }
  }

  return fallback;
}
