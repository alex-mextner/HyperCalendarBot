// src/services/voice/stress-marker.ts
import type { StressDictionary } from './stress-dictionary';

const RUSSIAN_WORD = /[а-яёА-ЯЁ]+/g;

const ONES = ['', 'один', 'два', 'три', 'чет+ыре', 'пять', 'шесть', 'семь', 'в+осемь', 'д+евять'];
const TEENS = [
  'д+есять',
  'один+адцать',
  'двен+адцать',
  'трин+адцать',
  'четырн+адцать',
  'пятн+адцать',
  'шестн+адцать',
  'семн+адцать',
  'восемн+адцать',
  'девятн+адцать',
];
const TENS = [
  '',
  'д+есять',
  'дв+адцать',
  'тр+идцать',
  'с+орок',
  'пятьдес+ят',
  'шестьдес+ят',
  'с+емьдесят',
  'в+осемьдесят',
  'девян+осто',
];
const HUNDREDS = [
  '',
  'сто',
  'дв+ести',
  'тр+иста',
  'чет+ыреста',
  'пятьс+от',
  'шестьс+от',
  'семьс+от',
  'восемьс+от',
  'девятьс+от',
];

function numToWords(n: number): string {
  if (n < 0 || n > 999 || !Number.isInteger(n)) return String(n);
  if (n === 0) return 'ноль';

  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const t = Math.floor(rest / 10);
  const o = rest % 10;

  if (h > 0) parts.push(HUNDREDS[h]);
  if (rest >= 10 && rest <= 19) {
    parts.push(TEENS[rest - 10]);
  } else {
    if (t > 0) parts.push(TENS[t]);
    if (o > 0) parts.push(ONES[o]);
  }

  return parts.join(' ');
}

/**
 * Convert time patterns (HH:MM) and standalone numbers to Russian words for TTS.
 */
export function numbersToWords(text: string): string {
  return (
    text
      // Time: 15:00, 9:30
      .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
        const hours = numToWords(Number.parseInt(h, 10));
        const mins = Number.parseInt(m, 10);
        if (mins === 0) return hours;
        return `${hours} ${numToWords(mins)}`;
      })
      // Standalone numbers up to 999
      .replace(/\b(\d{1,3})\b/g, (_, n) => numToWords(Number.parseInt(n, 10)))
  );
}

/**
 * Adds stress marks (+) to Russian text using the stress dictionary.
 * Words not found in the dictionary are left unchanged (Silero has auto-stress).
 * Preserves original punctuation and spacing.
 */
export function markStress(text: string, dict: StressDictionary): string {
  return text.replace(RUSSIAN_WORD, (word) => {
    const stressed = dict.lookup(word);
    if (!stressed) return word;

    // Preserve original casing: if original starts with uppercase, capitalize stressed form
    if (word[0] === word[0].toUpperCase() && stressed[0] !== '+') {
      return stressed[0].toUpperCase() + stressed.slice(1);
    }
    if (word[0] === word[0].toUpperCase() && stressed[0] === '+') {
      return `+${stressed[1].toUpperCase()}${stressed.slice(2)}`;
    }
    return stressed;
  });
}

const DATE_ORDINALS: Record<number, string> = {
  1: 'первого',
  2: 'второго',
  3: 'третьего',
  4: 'четвёртого',
  5: 'пятого',
  6: 'шестого',
  7: 'седьмого',
  8: 'восьмого',
  9: 'девятого',
  10: 'десятого',
  11: 'одиннадцатого',
  12: 'двенадцатого',
  13: 'тринадцатого',
  14: 'четырнадцатого',
  15: 'пятнадцатого',
  16: 'шестнадцатого',
  17: 'семнадцатого',
  18: 'восемнадцатого',
  19: 'девятнадцатого',
  20: 'двадцатого',
  21: 'двадцать первого',
  22: 'двадцать второго',
  23: 'двадцать третьего',
  24: 'двадцать четвёртого',
  25: 'двадцать пятого',
  26: 'двадцать шестого',
  27: 'двадцать седьмого',
  28: 'двадцать восьмого',
  29: 'двадцать девятого',
  30: 'тридцатого',
  31: 'тридцать первого',
};

const MONTH_GENITIVE =
  /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/g;

/**
 * Replaces "N месяца" date patterns with ordinal form before numbersToWords.
 * E.g. "17 марта" → "семнадцатого марта".
 */
export function fixDateOrdinals(text: string): string {
  return text.replace(MONTH_GENITIVE, (_, day, month) => {
    const n = Number.parseInt(day, 10);
    const ordinal = DATE_ORDINALS[n];
    return ordinal ? `${ordinal} ${month}` : `${day} ${month}`;
  });
}

/**
 * Converts line breaks to TTS-friendly pauses.
 * Double newline → ". " (sentence boundary), single newline → ", " (short pause).
 * Skips conversion if the line already ends with punctuation to avoid doubling.
 */
export function fixLineBreaks(text: string): string {
  return text
    .replace(/(?<![.!?,])\n\n/g, '. ')
    .replace(/(?<![.!?,])\n/g, ', ')
    .replace(/([.!?,])\n\n/g, '$1 ')
    .replace(/([.!?,])\n/g, '$1 ');
}

/**
 * Strips markdown formatting and non-speech content from AI response text for TTS.
 */
export function stripMarkdown(text: string): string {
  return (
    text
      // Remove image/link markdown
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
      // Remove bold/italic
      .replace(/\*{1,2}(.*?)\*{1,2}/g, '$1')
      .replace(/_{1,2}(.*?)_{1,2}/g, '$1')
      // Remove code
      .replace(/`([^`]+)`/g, '$1')
      // Remove headers
      .replace(/^#{1,6}\s+/gm, '')
      // Remove bullet points
      .replace(/^[-•]\s+/gm, '')
      // Remove emoji (surrogate pairs and misc symbols)
      .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '')
      // Remove tool execution lines (⏳, ✅, ❌ with tool names)
      .replace(/^[⏳✅❌].*$/gm, '')
      // Collapse whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Transliterate English words to Russian phonetic approximation for Silero TTS.
 * Silero only reads Russian — English words get skipped silently.
 */
export function transliterateEnglish(text: string): string {
  const EN_TO_RU: Record<string, string> = {
    a: 'а',
    b: 'б',
    c: 'к',
    d: 'д',
    e: 'е',
    f: 'ф',
    g: 'г',
    h: 'х',
    i: 'и',
    j: 'дж',
    k: 'к',
    l: 'л',
    m: 'м',
    n: 'н',
    o: 'о',
    p: 'п',
    q: 'к',
    r: 'р',
    s: 'с',
    t: 'т',
    u: 'у',
    v: 'в',
    w: 'в',
    x: 'кс',
    y: 'й',
    z: 'з',
    sh: 'ш',
    ch: 'ч',
    th: 'з',
    ph: 'ф',
    ck: 'к',
    ee: 'и',
    oo: 'у',
    ou: 'ау',
    ow: 'оу',
    ea: 'и',
    ai: 'эй',
    ay: 'эй',
    ey: 'эй',
    oi: 'ой',
    oy: 'ой',
    er: 'ер',
    ar: 'ар',
    or: 'ор',
    ir: 'ир',
    tion: 'шн',
    sion: 'жн',
    ight: 'айт',
  };

  // Replace English words with transliteration
  return text.replace(/[a-zA-Z]+/g, (word) => {
    let result = '';
    const lower = word.toLowerCase();
    let i = 0;
    while (i < lower.length) {
      // Try 4, 3, 2 char combos first
      let matched = false;
      for (const len of [4, 3, 2]) {
        const combo = lower.slice(i, i + len);
        if (EN_TO_RU[combo]) {
          result += EN_TO_RU[combo];
          i += len;
          matched = true;
          break;
        }
      }
      if (!matched) {
        result += EN_TO_RU[lower[i]] ?? lower[i];
        i++;
      }
    }
    return result;
  });
}
