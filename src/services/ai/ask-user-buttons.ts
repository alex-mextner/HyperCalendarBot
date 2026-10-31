// src/services/ai/ask-user-buttons.ts
// Callback data of ask_user buttons and the limits of the Telegram keyboard that carries them.
//
// Telegram rejects a button whose callback_data is over 64 UTF-8 bytes (BUTTON_DATA_INVALID) and
// Cyrillic costs two bytes a character, so an option over ~25 Russian characters cannot ride in
// its own callback data. Two forms therefore exist:
//   - `ai_btn:{text}` / `ai_btn:{userId}:{text}`: the answer is the payload. Kept whenever it fits,
//     so buttons already sitting in chats keep working.
//   - `ai_opt:{index}` / `ai_opt:{userId}:{index}`: the payload only makes the button unique. The
//     tap handler reads the answer from the label of the tapped button in the message's own inline
//     keyboard, so the AI gets the full option text however long it is and nothing is stored
//     server-side. A separate action name means an answer text can never be mistaken for an index
//     (the colon/numeric-prefix ambiguity documented at `parseAiBtnPayload`).

export const AI_BUTTON_ACTION = 'ai_btn';
export const AI_OPTION_ACTION = 'ai_opt';

const CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Buttons per ask_user keyboard: the 100-button total recorded in docs/reference/telegram-limits.md.
 * That line carries no source link, so treat it as the repo's working limit, not a verified one.
 */
export const MAX_ASK_USER_OPTIONS = 100;

/** Callback data for option `index`; the group form restricts the answer to `restrictedToUserId`. */
export function askUserCallbackData(index: number, option: string, restrictedToUserId?: number): string {
  const restriction = restrictedToUserId ? `${restrictedToUserId}:` : '';
  const direct = `${AI_BUTTON_ACTION}:${restriction}${option}`;
  if (Buffer.byteLength(direct, 'utf8') <= CALLBACK_DATA_MAX_BYTES) return direct;
  return `${AI_OPTION_ACTION}:${restriction}${index}`;
}

/** Parses an `ai_opt` payload: "{index}" (private) or "{userId}:{index}" (group). Undefined when malformed. */
export function parseAiOptionPayload(payload: string): { restrictedToUserId?: number } | undefined {
  const segments = payload.split(':');
  if (segments.length > 2 || !segments.every((segment) => /^\d+$/.test(segment))) return undefined;
  return segments.length === 2 ? { restrictedToUserId: Number(segments[0]) } : {};
}

/** The rows of an inline keyboard as Telegram returns them on the tapped message. */
export type InlineKeyboardRows = ReadonlyArray<ReadonlyArray<{ text: string; callback_data?: string }>>;

/**
 * What the keyboard cannot carry, worded for the model so it can correct the call: an empty question
 * or option (a blank label removes its row) and more buttons than the documented keyboard limit. A
 * label over 64 callback_data bytes is not a problem: it rides as an index, however long it is.
 */
export function askUserInputProblem(
  question: string,
  options: readonly string[],
  addedButton?: string,
): string | undefined {
  if (question.trim() === '') return 'the question is empty';
  if (options.length > MAX_ASK_USER_OPTIONS) {
    // The cap is on buttons, so a button the tool appends itself counts: say so, in the model's own terms.
    return addedButton === undefined
      ? `${options.length} options do not fit on one Telegram keyboard (at most ${MAX_ASK_USER_OPTIONS}); offer fewer choices`
      : `${options.length - 1} options plus the "${addedButton}" button this tool adds itself do not fit on one Telegram keyboard (at most ${MAX_ASK_USER_OPTIONS} buttons: ${MAX_ASK_USER_OPTIONS - 1} of your options); offer fewer choices`;
  }
  const blank = options.findIndex((option) => option.trim() === '');
  if (blank !== -1) return `option ${blank + 1} is empty; every option needs visible button text`;
  return undefined;
}
