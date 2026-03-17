// src/services/intent/normalizer.ts

const PUNCTUATION_RE = /[.,!?;:()\[\]{}"'«»—–…\-]/g;
const WHITESPACE_RE = /\s+/g;

/** Lowercase, trim, strip punctuation, collapse whitespace */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCTUATION_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/** Normalize then split on whitespace into Set */
export function tokenize(text: string): Set<string> {
  const normalized = normalize(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(' '));
}
