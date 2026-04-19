// src/bot/handlers/group-message-filter.ts
//
// Stage 1 gate for group messages: decides whether an incoming message in a
// group chat is worth forwarding to the pipeline. A second-stage NLI filter
// and the AI system prompt drop remaining false positives, so this gate is
// allowed to be generous — it only has to catch plausibly calendar-related
// text and known direct-address triggers.

// Full words/phrases for calendar-related keyword matching in groups.
// Uses word boundaries to avoid false positives (e.g., "планшет" ≠ "план").
const CALENDAR_KEYWORDS = [
  // RU — full words or long enough stems
  'событие',
  'события',
  'событий',
  'встреча',
  'встречу',
  'встречи',
  'встречаемся',
  'потусим',
  'потусить',
  'потусуем',
  'собираемся',
  'собираться',
  'планирую',
  'планируем',
  'запланируй',
  'запланировать',
  'напомни',
  'напоминание',
  'напомнить',
  'календарь',
  'календар',
  'расписание',
  'расписани',
  'когда',
  'во сколько',
  'перенеси',
  'перенести',
  'перенос',
  'отмени',
  'отменить',
  'отмена',
  'удали',
  'удалить',
  'завтра',
  'послезавтра',
  'сегодня',
  'запись',
  'записаться',
  'записать',
  'назначить',
  'назначь',
  'отложить',
  'отложи',
  // EN — full words
  'event',
  'events',
  'meeting',
  'schedule',
  'scheduled',
  'reminder',
  'remind',
  'calendar',
  'appointment',
  'reschedule',
  'postpone',
  'tomorrow',
  'today',
];

// --- Fuzzy phonetic matching ---

/** Russian phonetic normalization: canonicalize voiced/voiceless pairs, remove soft/hard signs. */
export function phoneticNormalize(word: string): string {
  let s = word.toLowerCase();
  s = s.replace(/ё/g, 'е');
  s = s.replace(/[ъь]/g, '');
  s = s.replace(/б/g, 'п');
  s = s.replace(/в/g, 'ф');
  s = s.replace(/г/g, 'к');
  s = s.replace(/д/g, 'т');
  s = s.replace(/ж/g, 'ш');
  s = s.replace(/з/g, 'с');
  s = s.replace(/(.)\1+/g, '$1');
  return s;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

/** Max Levenshtein distance allowed for a given normalized word length. */
function maxEditDistance(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  return 2;
}

/** Pre-computed normalized keyword forms for fuzzy matching. */
const NORMALIZED_KEYWORDS = CALENDAR_KEYWORDS.map((kw) => {
  const parts = kw.split(/\s+/);
  return { normalized: parts.map(phoneticNormalize) };
});

/** Check if text contains any calendar keyword (fuzzy phonetic match). */
export function matchesKeywordFuzzy(text: string): boolean {
  const inputWords = text
    .toLowerCase()
    .split(/[\s,.!?;:()]+/)
    .filter((w) => w.length > 0);
  const normalizedInput = inputWords.map(phoneticNormalize);

  for (const kw of NORMALIZED_KEYWORDS) {
    if (kw.normalized.length === 1) {
      const kwNorm = kw.normalized[0]!;
      for (const inputNorm of normalizedInput) {
        const maxDist = maxEditDistance(kwNorm.length);
        if (levenshtein(inputNorm, kwNorm) <= maxDist) return true;
      }
    } else {
      // Multi-word keyword (e.g. "во сколько") — all parts must appear in sequence
      for (let i = 0; i <= normalizedInput.length - kw.normalized.length; i++) {
        let allMatch = true;
        for (let j = 0; j < kw.normalized.length; j++) {
          const inputNorm = normalizedInput[i + j]!;
          const kwNorm = kw.normalized[j]!;
          const maxDist = maxEditDistance(kwNorm.length);
          if (levenshtein(inputNorm, kwNorm) > maxDist) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) return true;
      }
    }
  }
  return false;
}

const ADDRESS_TARGETS = ['календарь', 'calendar'];
const ADDRESS_MAX_DISTANCE = 2;

// Exact "календарь"/"calendar" words are already in keyword list.
// This function handles typos only in the address prefix (e.g. "Каледарь,", "Calender,").
function startsWithCalendarAddress(text: string): boolean {
  const firstWord = (text.trim().split(/[\s,!.?:]+/)[0] ?? '').toLowerCase();
  if (firstWord.length < 5) return false;
  return ADDRESS_TARGETS.some((target) => levenshtein(firstWord, target) <= ADDRESS_MAX_DISTANCE);
}

// --- Direct-address "бот"/"bot" mention ---
//
// Short (3-letter) keywords can't go through the fuzzy matcher because
// phonetic normalization collapses them with unrelated words (e.g.
// "бот" → "пот", which would spuriously match "пот" = sweat). Match the
// bare lemma and its common Russian/English inflections as whole words,
// case-insensitive. The second-stage filters still have the final say.
const BOT_MENTION_RE =
  /(?<![\p{L}\p{N}])(?:бот|бота|боту|ботом|боте|боты|ботов|ботам|ботами|ботах|bot|bots)(?![\p{L}\p{N}])/iu;

export function mentionsBot(text: string): boolean {
  return BOT_MENTION_RE.test(text);
}

// --- Date / time hints ---
//
// A message that carries a concrete date or time is plausibly a calendar
// request — forward it to the AI, which will [SKIP] if the date mention is
// not actionable (e.g. "доставка будет 1 апреля" in small talk).
//
// Covered formats:
//   • numeric date:  15.04, 15/04, 15-4, 15.04.2025, 2025-04-15
//   • day + month:   "15 апреля", "15 апр", "15 april", "апреля 15", "apr 15"
//   • time of day:   "15:30", "в 15:00", "at 8:30" (bare numbers like "at 8"
//                    are too ambiguous — they trip on prices, scores, etc.)

// Candidate numeric date: DD.MM, DD.MM.YYYY, YYYY-MM-DD.
// The second lookbehind rejects matches that are part of a longer dotted/dashed
// sequence (IP addresses like 192.168.1.1, phone numbers +7-999-123-45-67).
const NUMERIC_DATE_CANDIDATE_RE =
  /(?<![\p{L}\p{N}])(?<!\d[./-])(\d{1,4})([./-])(\d{1,2})(?:\2(\d{2,4}))?(?![\p{L}\p{N}])/gu;

function containsNumericDate(text: string): boolean {
  for (const m of text.matchAll(NUMERIC_DATE_CANDIDATE_RE)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    // YYYY-MM-DD: first group is a 4-digit year
    if (m[1]!.length === 4) {
      if (b >= 1 && b <= 12 && (!m[4] || (Number(m[4]) >= 1 && Number(m[4]) <= 31))) return true;
      continue;
    }
    // DD.MM or DD.MM.YYYY: day 1-31, month 1-12
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) return true;
  }
  return false;
}

// Long month stems. Matched with up to 3 trailing letters so Russian case
// endings (апрел+я, октябр+е, январ+ями) are covered without listing every
// form. The {0,3} cap rejects false positives like "мартышек" (4+ letter tail).
// `ма[йяю]` handles "май", "мая", "маю" — stems shorter than four chars don't
// share a common prefix the way the others do.
const MONTH_STEMS_LONG =
  'январ|феврал|март|апрел|ма[йяю]|июн|июл|август|сентябр|октябр|ноябр|декабр|' +
  'january|february|march|april|june|july|august|september|october|november|december';

// Short abbreviations. Matched only when standalone (no letter immediately after).
const MONTH_STEMS_SHORT = 'янв|фев|мар|апр|май|авг|сен|окт|ноя|дек|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec';

const MONTH_TOKEN = `(?:(?:${MONTH_STEMS_LONG})[\\p{L}]{0,3}(?![\\p{L}])|(?:${MONTH_STEMS_SHORT})(?![\\p{L}]))`;

// "15 апреля", "15 апр", "15 april", "apr 15", "октября 10"
const DAY_MONTH_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:\\d{1,2}\\s+${MONTH_TOKEN}|${MONTH_TOKEN}\\s+\\d{1,2})(?![\\p{L}\\p{N}])`,
  'iu',
);

// "15:30", "в 15:00", "at 8:30"
const TIME_RE = /(?<![\p{L}\p{N}])\d{1,2}:\d{2}(?![\p{L}\p{N}])/u;

export function containsDateHint(text: string): boolean {
  if (containsNumericDate(text)) return true;
  if (DAY_MONTH_RE.test(text)) return true;
  if (TIME_RE.test(text)) return true;
  return false;
}

/**
 * Decide whether an incoming group message should be forwarded to the pipeline.
 * Returns true on any direct-address signal or calendar-related hint.
 * False positives are filtered downstream by NLI and the AI system prompt.
 */
export function isGroupRelevant(text: string, botUsername: string): boolean {
  if (botUsername && text.includes(`@${botUsername}`)) return true;
  if (startsWithCalendarAddress(text)) return true;
  if (mentionsBot(text)) return true;
  if (matchesKeywordFuzzy(text)) return true;
  if (containsDateHint(text)) return true;
  return false;
}
