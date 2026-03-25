import { describe, expect, test } from 'bun:test';

// Extract the keyword pattern logic for testing
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
  'перенеси',
  'перенести',
  'перенос',
  'удали',
  'удалить',
  'послезавтра',
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
];

const KEYWORD_PATTERN = new RegExp(`(?:^|\\s|[,.!?])(?:${CALENDAR_KEYWORDS.join('|')})(?:\\s|[,.!?]|$)`, 'i');

function matchesKeyword(text: string): boolean {
  return KEYWORD_PATTERN.test(text);
}

describe('group message keyword filter', () => {
  describe('matches relevant messages', () => {
    test('встреча завтра', () => expect(matchesKeyword('встреча завтра в 15:00')).toBe(true));
    test('планируем event', () => expect(matchesKeyword('планируем встречу')).toBe(true));
    test('напомни мне', () => expect(matchesKeyword('напомни мне в 9')).toBe(true));
    test('когда собираемся', () => expect(matchesKeyword('когда собираемся?')).toBe(true));
    test('потусим завтра', () => expect(matchesKeyword('потусим завтра?')).toBe(true));
    test('schedule meeting', () => expect(matchesKeyword("let's schedule a meeting")).toBe(true));
    test('meeting at 3', () => expect(matchesKeyword('meeting at 3pm')).toBe(true));
    test('event at start of message', () => expect(matchesKeyword('event tomorrow')).toBe(true));
    test('reminder please', () => expect(matchesKeyword('set a reminder')).toBe(true));
    test('перенеси на пятницу', () => expect(matchesKeyword('перенеси встречу на пятницу')).toBe(true));
    test('удалить событие', () => expect(matchesKeyword('удалить событие')).toBe(true));
    test('case insensitive', () => expect(matchesKeyword('ВСТРЕЧА ЗАВТРА')).toBe(true));
    test('with punctuation', () => expect(matchesKeyword('событие!')).toBe(true));
  });

  describe('does NOT match irrelevant messages', () => {
    test('планшет купил', () => expect(matchesKeyword('планшет купил новый')).toBe(false));
    test('местоимение', () => expect(matchesKeyword('это местоимение')).toBe(false));
    test('eventually', () => expect(matchesKeyword('it will eventually work')).toBe(false));
    test('prevent', () => expect(matchesKeyword('prevent this from happening')).toBe(false));
    test('random chat', () => expect(matchesKeyword('привет, как дела?')).toBe(false));
    test('code discussion', () => expect(matchesKeyword('push the fix to main')).toBe(false));
    test('food talk', () => expect(matchesKeyword('закажем пиццу')).toBe(false));

    test.each([
      'завтра поедем на визаран',
      'сегодня жарко',
      'когда приедешь?',
      'отмена на стороне визаранщика',
      'во сколько будешь дома?',
      'отмени подписку на нетфликс',
      'see you tomorrow',
      'today is hot',
    ])('should NOT match casual usage: "%s"', (text) => {
      expect(matchesKeyword(text)).toBe(false);
    });
  });
});
