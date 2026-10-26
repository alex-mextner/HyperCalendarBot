// How a spoken mention of an existing event ("йогу", "стоматолога", "the dentist appointment") becomes the one word
// the title search can find it by. Case endings and filler nouns are cut; a mention with nothing left to search by
// is refused, so the caller hands the message to the AI instead of guessing which event was meant.
import { normalize } from './normalizer.ts';

/** Words that say "an event" or "mine" but never which one: searching by them would match anything or nothing. */
const GENERIC_WORDS: { [word: string]: true } = Object.fromEntries(
  [
    'событие',
    'события',
    'событию',
    'событием',
    'событии',
    'встреча',
    'встречу',
    'встречи',
    'встрече',
    'встречей',
    'мероприятие',
    'мероприятия',
    'запись',
    'event',
    'events',
    'meeting',
    'meetings',
    'appointment',
    'appointments',
    'session',
    'sessions',
    'my',
    'the',
    'this',
    'that',
    'мой',
    'моя',
    'мою',
    'мое',
    'моё',
    'мои',
    'эту',
    'это',
    'этот',
    'эта',
    'из',
    'календаря',
    'календарь',
    'календаре',
    'calendar',
    'from',
    'with',
    'for',
    'про',
    'мне',
    'me',
  ].map((word) => [word, true] as const),
);

/** Russian case endings, longest alternatives first so "-ами" is cut whole, not as "-и". */
const RU_ENDING =
  /(?:ыми|ими|ого|его|ому|ему|ами|ями|ов|ев|ом|ем|ой|ей|ам|ям|ах|ях|ою|ею|ую|юю|ая|яя|ое|ее|ые|ие|ый|ий|ых|их|у|ю|а|я|ы|и|е|о|ь)$/;

const MIN_STEM = 4;
const MIN_SHORT_STEM = 3;
const MIN_WORD = 3;

/** One word of the mention without its inflection: "йогу" → "йог", "тренировку" → "тренировк", "parents" → "parent". */
function stemOf(word: string): string {
  if (/^[а-яё]+$/.test(word)) {
    const stem = word.replace(RU_ENDING, '');
    if (stem.length >= MIN_STEM) return stem;
    // "йога", "йогу", "йогой": a three-letter stem is safe only when little more than the ending was cut.
    return stem.length >= MIN_SHORT_STEM && word.length <= stem.length + 2 ? stem : word;
  }
  return /^[a-z]{5,}s$/.test(word) && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * The substring of a title that identifies the event the user named: the longest meaningful word, inflection cut.
 * Null when the mention holds no such word ("событие", "my meeting") — nothing to search by.
 */
export function distinctiveStem(mention: string): string | null {
  let best: string | null = null;
  for (const word of normalize(mention).split(' ')) {
    if (word.length < MIN_WORD || Object.hasOwn(GENERIC_WORDS, word) || /^\d+$/.test(word)) continue;
    const stem = stemOf(word);
    if (best === null || stem.length > best.length) best = stem;
  }
  return best;
}
