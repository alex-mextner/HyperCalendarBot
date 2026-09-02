/**
 * Approximate token accounting for outgoing AI requests, without pulling in a
 * tokenizer dependency.
 *
 * The rates below are average characters-per-token for the byte-pair vocabularies
 * used by the providers in the fallback chain (z.ai, Groq, Gemini, HuggingFace).
 * They are calibrated against two measured points:
 *
 * - the 41 759-character tool catalog was billed by a provider at ~11 900 tokens
 *   when sent as raw JSON (3.5 chars/token);
 * - Groq's own per-minute accounting reported ~7 750 tokens for the same catalog,
 *   because its Harmony template renders tool schemas as a compact type
 *   declaration instead of JSON.
 *
 * So treat the result as a conservative upper bound with roughly ±20% error. It
 * exists to compare payload sizes before and after a change and to guard budgets
 * in tests — never to predict a provider's exact billing.
 */

const CHARS_PER_TOKEN_ASCII = 3.5;
const CHARS_PER_TOKEN_CYRILLIC = 2.0;
const CHARS_PER_TOKEN_OTHER = 1.2;

const CYRILLIC_START = 0x0400;
const CYRILLIC_END = 0x052f;

function isCyrillic(codePoint: number): boolean {
  return codePoint >= CYRILLIC_START && codePoint <= CYRILLIC_END;
}

/** Estimated token count of a string. Returns 0 for the empty string. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let cyrillic = 0;
  let other = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 128) ascii++;
    else if (isCyrillic(codePoint)) cyrillic++;
    else other++;
  }

  const tokens = ascii / CHARS_PER_TOKEN_ASCII + cyrillic / CHARS_PER_TOKEN_CYRILLIC + other / CHARS_PER_TOKEN_OTHER;
  return Math.ceil(tokens);
}
