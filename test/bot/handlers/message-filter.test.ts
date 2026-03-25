import { describe, expect, test } from 'bun:test';

// Mirror of CALENDAR_KEYWORDS from message.handler.ts
const CALENDAR_KEYWORDS = [
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

// Mirror of phoneticNormalize from message.handler.ts
function phoneticNormalize(word: string): string {
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

function maxEditDistance(len: number): number {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  return 2;
}

const NORMALIZED_KEYWORDS = CALENDAR_KEYWORDS.map((kw) => {
  const parts = kw.split(/\s+/);
  return { normalized: parts.map(phoneticNormalize) };
});

function matchesKeyword(text: string): boolean {
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

describe('group message keyword filter', () => {
  describe('matches relevant messages (exact)', () => {
    test('встреча завтра', () => expect(matchesKeyword('встреча завтра в 15:00')).toBe(true));
    test('планируем встречу', () => expect(matchesKeyword('планируем встречу')).toBe(true));
    test('напомни мне', () => expect(matchesKeyword('напомни мне в 9')).toBe(true));
    test('когда собираемся', () => expect(matchesKeyword('когда собираемся?')).toBe(true));
    test('потусим завтра', () => expect(matchesKeyword('потусим завтра?')).toBe(true));
    test('schedule meeting', () => expect(matchesKeyword("let's schedule a meeting")).toBe(true));
    test('tomorrow at 3', () => expect(matchesKeyword('tomorrow at 3pm')).toBe(true));
    test('event at start of message', () => expect(matchesKeyword('event tomorrow')).toBe(true));
    test('reminder please', () => expect(matchesKeyword('set a reminder')).toBe(true));
    test('перенеси на пятницу', () => expect(matchesKeyword('перенеси встречу на пятницу')).toBe(true));
    test('удалить событие', () => expect(matchesKeyword('удалить событие')).toBe(true));
    test('case insensitive', () => expect(matchesKeyword('ВСТРЕЧА ЗАВТРА')).toBe(true));
    test('with punctuation', () => expect(matchesKeyword('событие!')).toBe(true));
    test('запись к врачу', () => expect(matchesKeyword('запись к врачу на среду')).toBe(true));
    test('назначить встречу', () => expect(matchesKeyword('назначить встречу')).toBe(true));
    test('отложи на час', () => expect(matchesKeyword('отложи на час')).toBe(true));
  });

  describe('matches with typos (Levenshtein)', () => {
    test('каледарь (missing н)', () => expect(matchesKeyword('каледарь покажи')).toBe(true));
    test('напомини (extra и)', () => expect(matchesKeyword('напомини мне')).toBe(true));
    test('расписанние (double н)', () => expect(matchesKeyword('покажи расписанние')).toBe(true));
    test('собиремся (wrong vowel)', () => expect(matchesKeyword('собиремся в 8')).toBe(true));
    test('запланировтаь (transposition)', () => expect(matchesKeyword('запланировтаь на завтра')).toBe(true));
    test('calender (common EN typo)', () => expect(matchesKeyword('check the calender')).toBe(true));
    test('shcedule (common EN typo)', () => expect(matchesKeyword('shcedule a call')).toBe(true));
    test('remiinder (double i)', () => expect(matchesKeyword('set a remiinder')).toBe(true));
  });

  describe('matches with phonetic variations (devoicing)', () => {
    test('фстреча (в→ф devoicing)', () => expect(matchesKeyword('фстреча в 10')).toBe(true));
    test('сопытие (б→п devoicing)', () => expect(matchesKeyword('сопытие в парке')).toBe(true));
    test('сафтра (з→с, в→ф devoicing)', () => expect(matchesKeyword('сафтра пойдем')).toBe(true));
    test('напомнёт (ё→е, close to напомнить)', () => expect(matchesKeyword('напомнёт мне')).toBe(true));
    test('soft sign removed (календарь = календар)', () => expect(matchesKeyword('календар покажи')).toBe(true));
  });

  describe('does NOT match irrelevant messages', () => {
    test('планшет купил', () => expect(matchesKeyword('планшет купил новый')).toBe(false));
    test('местоимение', () => expect(matchesKeyword('это местоимение')).toBe(false));
    test('eventually', () => expect(matchesKeyword('it will eventually work')).toBe(false));
    test('prevent', () => expect(matchesKeyword('prevent this from happening')).toBe(false));
    test('random chat', () => expect(matchesKeyword('привет, как дела?')).toBe(false));
    test('code discussion', () => expect(matchesKeyword('push the fix to main')).toBe(false));
    test('food talk', () => expect(matchesKeyword('закажем пиццу')).toBe(false));
    test('short random words', () => expect(matchesKeyword('ну ок')).toBe(false));
    test('politics', () => expect(matchesKeyword('новости из парламента')).toBe(false));
  });

  describe('phoneticNormalize', () => {
    test('voiced → voiceless', () => {
      expect(phoneticNormalize('встреча')).toBe('фстреча');
      expect(phoneticNormalize('событие')).toBe('сопытие');
      expect(phoneticNormalize('завтра')).toBe('сафтра');
    });
    test('ё → е', () => {
      expect(phoneticNormalize('ещё')).toBe('еще');
    });
    test('removes ъ and ь', () => {
      expect(phoneticNormalize('календарь')).toBe('калентар');
      expect(phoneticNormalize('объект')).toBe('опект');
    });
    test('collapses doubles', () => {
      expect(phoneticNormalize('рассписание')).toBe('расписание');
      // After normalization: р stays, а stays, сс→с, п stays, и stays, с stays, а stays, н stays, и stays, е stays
    });
  });
});
