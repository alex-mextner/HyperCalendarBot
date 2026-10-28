// Conservative canonical form of a user message for the strict rule patterns: ё folded to е, trailing punctuation,
// leading courtesy words and trailing "пожалуйста" dropped, and (second pass only) single-letter typos of the fixed
// command vocabulary repaired. Every character of the canonical text maps back to a span of the raw message, so
// rule captures (titles, usernames) are always read from what the user actually wrote.

export interface CanonicalText {
  text: string;
  spans: { start: number; end: number }[];
  /** Per character: it belongs to a word the typo repair replaced (set only by repairTypos). */
  replaced?: boolean[];
}

const LEADING_FILLER =
  /^(?:пожалуйста|пожалуйста,|плиз|плз|пжлст|please|pls|слушай|слышь|эй|ну|короче|так|а|и|ok|okay|ок|окей|uh|um|hmm|well|alright|эм|ээ|бот|bot|hey bot|hi bot|hey|привет|прошу|будь добр|будь добра|будь так добр|мне нужно|мне надо|мне бы|хочу|нужно|надо|можешь ли ты|можешь|ты можешь|сможешь|не мог бы ты|не могла бы ты|давай|давайте|could you|can you|would you|will you|i want to|i need to|i'd like to|i would like to|let's|let us)(?=[\s,:;.!-]|$)[\s,:;.!-]*/i;
const TRAILING_FILLER = /[\s,;:.!-]+(?:пожалуйста|плиз|плз|пжлст|please|pls|спасибо|thanks|thx|ладно|ok|ок)$/i;
const TRAILING_PUNCTUATION = /[\s.,;:!?…)(]+$/;
const LEADING_PUNCTUATION = /^[\s.,;:!?…—–-]+/;
const MAX_FILLER_ROUNDS = 4;

function slice(canon: CanonicalText, from: number, to: number): CanonicalText {
  return { text: canon.text.slice(from, to), spans: canon.spans.slice(from, to) };
}

function foldCharacter(character: string): string {
  if (character === 'ё') return 'е';
  if (character === 'Ё') return 'Е';
  // A line break reads as " ; ": a pasted "date / time / title" block is one request, but a day word alone on its
  // line is a list heading and must not bind to the next line's number.
  return /[\r\n\u2028\u2029]/u.test(character) ? ' ; ' : character;
}

function trimTrailingPunctuation(canon: CanonicalText): CanonicalText {
  return slice(canon, 0, canon.text.length - (TRAILING_PUNCTUATION.exec(canon.text)?.[0].length ?? 0));
}

/** Folds ё/Ё (same length) and strips the noise around a command. */
export function canonicalize(raw: string): CanonicalText {
  const spans: CanonicalText['spans'] = [];
  let text = '';
  let offset = 0;
  for (const character of raw) {
    const folded = foldCharacter(character);
    for (let unit = 0; unit < folded.length; unit++) spans.push({ start: offset, end: offset + character.length });
    text += folded;
    offset += character.length;
  }
  let canon = trimTrailingPunctuation({ text, spans });
  canon = slice(canon, LEADING_PUNCTUATION.exec(canon.text)?.[0].length ?? 0, canon.text.length);
  for (let round = 0; round < MAX_FILLER_ROUNDS; round++) {
    const lead = LEADING_FILLER.exec(canon.text);
    const tail = TRAILING_FILLER.exec(canon.text);
    if (!lead && !tail) break;
    const from = lead && lead[0].length < canon.text.length ? lead[0].length : 0;
    const to = tail ? canon.text.length - tail[0].length : canon.text.length;
    if (to <= from) break;
    canon = trimTrailingPunctuation(slice(canon, from, to));
  }
  return canon;
}

// ─── typo repair of the command vocabulary ───────────────────────────────────

/** Words whose misspelling a rule pattern would otherwise reject: command verbs, day and clock words, months. */
const VOCABULARY: readonly string[] = [
  // create / change / remove
  'создай',
  'добавь',
  'запланируй',
  'поставь',
  'запиши',
  'закинь',
  'внеси',
  'организуй',
  'назначь',
  'удали',
  'убери',
  'отмени',
  'сними',
  'перенеси',
  'передвинь',
  'сдвинь',
  'перекинь',
  'подвинь',
  'отложи',
  'скрой',
  'спрячь',
  'выкинь',
  'снеси',
  'назови',
  'измени',
  'поменяй',
  'напоминай',
  'переименуй',
  'напомни',
  'пригласи',
  'позови',
  'покажи',
  'найди',
  'поищи',
  'скажи',
  'create',
  'schedule',
  'delete',
  'remove',
  'cancel',
  'reschedule',
  'remind',
  'invite',
  'postpone',
  'snooze',
  'rename',
  'search',
  'show',
  // nouns the patterns anchor on
  'событие',
  'события',
  'встречу',
  'встреча',
  'встречи',
  'созвон',
  'расписание',
  'календарь',
  'напоминание',
  'meeting',
  'event',
  'events',
  'agenda',
  'calendar',
  'reminder',
  // days and periods
  'сегодня',
  'завтра',
  'послезавтра',
  'вчера',
  'неделю',
  'неделе',
  'месяц',
  'выходные',
  'выходных',
  'today',
  'tomorrow',
  'yesterday',
  'weekend',
  'понедельник',
  'вторник',
  'среду',
  'четверг',
  'пятницу',
  'субботу',
  'воскресенье',
  'понедельника',
  'вторника',
  'среды',
  'четверга',
  'пятницы',
  'субботы',
  'воскресенья',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  // clock words
  'утра',
  'вечера',
  'ночи',
  'полдень',
  'полночь',
  'через',
  'минут',
  'минуты',
  'часа',
  'часов',
  'день',
  'дня',
  'minutes',
  'hours',
  'tomorrow',
  // months (genitive)
  'января',
  'февраля',
  'марта',
  'апреля',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
  'january',
  'february',
  'march',
  'april',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const VOCABULARY_SET = new Set(VOCABULARY);
const MIN_TOKEN_LENGTH = 5;

/** Edit distance with adjacent transposition, cut off at 2. */
export function nearDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  return rows[a.length]![b.length]!;
}

function repairToken(token: string): string | null {
  const lower = token.toLowerCase();
  if (lower.length < MIN_TOKEN_LENGTH || VOCABULARY_SET.has(lower)) return null;
  let found: string | null = null;
  for (const word of VOCABULARY) {
    if (word[0] !== lower[0] || nearDistance(lower, word) > 1) continue;
    if (found !== null && found !== word) return null;
    found = word;
  }
  return found;
}

/**
 * The same text with misspelled command words replaced by the one vocabulary word they are a single edit from.
 * Null when nothing changed. A replaced word keeps the span of the word it replaces, so captures stay faithful.
 */
export function repairTypos(canon: CanonicalText): CanonicalText | null {
  let changed = false;
  const spans: CanonicalText['spans'] = [];
  const replaced: boolean[] = [];
  let text = '';
  const words = /[\p{L}]+|[^\p{L}]+/gu;
  for (const part of canon.text.matchAll(words)) {
    const start = part.index;
    const token = part[0];
    // A @username, #id or /command is data, never a misspelt command word.
    const protectedToken = /[@#/]/.test(canon.text[start - 1] ?? '');
    const fixed = /^\p{L}/u.test(token) && !protectedToken ? repairToken(token) : null;
    if (fixed === null) {
      text += token;
      for (let i = 0; i < token.length; i++) {
        spans.push(canon.spans[start + i]!);
        replaced.push(false);
      }
      continue;
    }
    changed = true;
    const whole = { start: canon.spans[start]!.start, end: canon.spans[start + token.length - 1]!.end };
    text += fixed;
    for (let i = 0; i < fixed.length; i++) {
      spans.push(whole);
      replaced.push(true);
    }
  }
  return changed ? { text, spans, replaced } : null;
}
