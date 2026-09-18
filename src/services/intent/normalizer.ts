// src/services/intent/normalizer.ts

const PUNCTUATION_RE = /[.,!?;:()[\]{}"'«»—–…-]/g;
const WHITESPACE_RE = /\s+/g;

/** Lowercase, trim, strip punctuation, collapse whitespace */
export function normalize(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION_RE, ' ').replace(WHITESPACE_RE, ' ').trim();
}

/** Normalize then split on whitespace into Set */
export function tokenize(text: string): Set<string> {
  const normalized = normalize(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(' '));
}

/** Normalize only for matching; spans let callers recover untouched argument text. */
export function normalizeWithOffsets(source: string): { text: string; spans: { start: number; end: number }[] } {
  const characters: string[] = [];
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  let lowerOffset = 0;
  const lowercase = source.toLowerCase();
  for (const character of source) {
    const end = start + character.length;
    const lowerLength = character.toLowerCase().length;
    const normalized = lowercase
      .slice(lowerOffset, lowerOffset + lowerLength)
      .replace(PUNCTUATION_RE, ' ')
      .replace(WHITESPACE_RE, ' ');
    lowerOffset += lowerLength;
    for (let i = 0; i < normalized.length; i++) {
      const unit = normalized[i]!;
      if (unit === ' ' && (!characters.length || characters[characters.length - 1] === ' ')) {
        if (spans.length) spans[spans.length - 1]!.end = end;
        continue;
      }
      characters.push(unit);
      spans.push({ start, end });
    }
    start = end;
  }
  if (characters[characters.length - 1] === ' ') {
    characters.pop();
    spans.pop();
  }
  return { text: characters.join(''), spans };
}
