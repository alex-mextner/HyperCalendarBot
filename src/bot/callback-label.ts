interface CallbackButtonLike {
  text?: unknown;
  callback_data?: unknown;
}

interface ReplyMarkupLike {
  inline_keyboard?: unknown;
}

/** Label of a button matching the callback data, or undefined when the button does not match / has no text. */
function labelIfMatches(rawButton: unknown, callbackData: string): string | undefined {
  if (!rawButton || typeof rawButton !== 'object') return undefined;
  const button = rawButton as CallbackButtonLike;
  if (button.callback_data !== callbackData || typeof button.text !== 'string') return undefined;
  return button.text.trim() || undefined;
}

function labelFromRow(row: unknown, callbackData: string): string | undefined {
  if (!Array.isArray(row)) return undefined;
  for (const rawButton of row) {
    const label = labelIfMatches(rawButton, callbackData);
    if (label) return label;
  }
  return undefined;
}

/** Resolve the user-visible label for a callback, falling back to its action code. */
export function resolveCallbackButtonLabel(replyMarkup: unknown, callbackData: string, fallback: string): string {
  if (!replyMarkup || typeof replyMarkup !== 'object') return fallback;
  const keyboard = (replyMarkup as ReplyMarkupLike).inline_keyboard;
  if (!Array.isArray(keyboard)) return fallback;

  for (const row of keyboard) {
    const label = labelFromRow(row, callbackData);
    if (label) return label;
  }

  return fallback;
}
