// src/config/constants/text-helpers.ts
// Small string helpers shared by the message tables.

/**
 * Pick a stall phrase, avoiding `exclude` so the same apology is never sent
 * twice in a row to the same user.
 */
export function pickPhrase(phrases: readonly string[], exclude?: string): string {
  const pool = exclude ? phrases.filter((phrase) => phrase !== exclude) : phrases;
  const source = pool.length > 0 ? pool : phrases;
  return source[Math.floor(Math.random() * source.length)]!;
}

/** Upper-cases the first character, for a relative-day word that opens a sentence. */
export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
