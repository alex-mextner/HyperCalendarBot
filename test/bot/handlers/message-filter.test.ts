import { describe, expect, test } from 'bun:test';
import {
  containsDateHint,
  isGroupRelevant,
  matchesKeywordFuzzy,
  mentionsBot,
  phoneticNormalize,
} from '../../../src/bot/handlers/group-message-filter.ts';

describe('group message keyword filter', () => {
  describe('matches relevant messages (exact)', () => {
    test('встреча завтра', () => expect(matchesKeywordFuzzy('встреча завтра в 15:00')).toBe(true));
    test('планируем встречу', () => expect(matchesKeywordFuzzy('планируем встречу')).toBe(true));
    test('напомни мне', () => expect(matchesKeywordFuzzy('напомни мне в 9')).toBe(true));
    test('когда собираемся', () => expect(matchesKeywordFuzzy('когда собираемся?')).toBe(true));
    test('потусим завтра', () => expect(matchesKeywordFuzzy('потусим завтра?')).toBe(true));
    test('schedule meeting', () => expect(matchesKeywordFuzzy("let's schedule a meeting")).toBe(true));
    test('tomorrow at 3', () => expect(matchesKeywordFuzzy('tomorrow at 3pm')).toBe(true));
    test('event at start of message', () => expect(matchesKeywordFuzzy('event tomorrow')).toBe(true));
    test('reminder please', () => expect(matchesKeywordFuzzy('set a reminder')).toBe(true));
    test('перенеси на пятницу', () => expect(matchesKeywordFuzzy('перенеси встречу на пятницу')).toBe(true));
    test('удалить событие', () => expect(matchesKeywordFuzzy('удалить событие')).toBe(true));
    test('case insensitive', () => expect(matchesKeywordFuzzy('ВСТРЕЧА ЗАВТРА')).toBe(true));
    test('with punctuation', () => expect(matchesKeywordFuzzy('событие!')).toBe(true));
    test('запись к врачу', () => expect(matchesKeywordFuzzy('запись к врачу на среду')).toBe(true));
    test('назначить встречу', () => expect(matchesKeywordFuzzy('назначить встречу')).toBe(true));
    test('отложи на час', () => expect(matchesKeywordFuzzy('отложи на час')).toBe(true));
  });

  describe('matches with typos (Levenshtein)', () => {
    test('каледарь (missing н)', () => expect(matchesKeywordFuzzy('каледарь покажи')).toBe(true));
    test('напомини (extra и)', () => expect(matchesKeywordFuzzy('напомини мне')).toBe(true));
    test('расписанние (double н)', () => expect(matchesKeywordFuzzy('покажи расписанние')).toBe(true));
    test('собиремся (wrong vowel)', () => expect(matchesKeywordFuzzy('собиремся в 8')).toBe(true));
    test('запланировтаь (transposition)', () => expect(matchesKeywordFuzzy('запланировтаь на завтра')).toBe(true));
    test('calender (common EN typo)', () => expect(matchesKeywordFuzzy('check the calender')).toBe(true));
    test('shcedule (common EN typo)', () => expect(matchesKeywordFuzzy('shcedule a call')).toBe(true));
    test('remiinder (double i)', () => expect(matchesKeywordFuzzy('set a remiinder')).toBe(true));
  });

  describe('matches with phonetic variations (devoicing)', () => {
    test('фстреча (в→ф devoicing)', () => expect(matchesKeywordFuzzy('фстреча в 10')).toBe(true));
    test('сопытие (б→п devoicing)', () => expect(matchesKeywordFuzzy('сопытие в парке')).toBe(true));
    test('сафтра (з→с, в→ф devoicing)', () => expect(matchesKeywordFuzzy('сафтра пойдем')).toBe(true));
    test('напомнёт (ё→е, close to напомнить)', () => expect(matchesKeywordFuzzy('напомнёт мне')).toBe(true));
    test('soft sign removed (календарь = календар)', () => expect(matchesKeywordFuzzy('календар покажи')).toBe(true));
  });

  describe('does NOT match irrelevant messages', () => {
    test('планшет купил', () => expect(matchesKeywordFuzzy('планшет купил новый')).toBe(false));
    test('местоимение', () => expect(matchesKeywordFuzzy('это местоимение')).toBe(false));
    test('eventually', () => expect(matchesKeywordFuzzy('it will eventually work')).toBe(false));
    test('prevent', () => expect(matchesKeywordFuzzy('prevent this from happening')).toBe(false));
    test('random chat', () => expect(matchesKeywordFuzzy('привет, как дела?')).toBe(false));
    test('code discussion', () => expect(matchesKeywordFuzzy('push the fix to main')).toBe(false));
    test('food talk', () => expect(matchesKeywordFuzzy('закажем пиццу')).toBe(false));
    test('short random words', () => expect(matchesKeywordFuzzy('ну ок')).toBe(false));
    test('politics', () => expect(matchesKeywordFuzzy('новости из парламента')).toBe(false));
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
    });
  });
});

describe('mentionsBot', () => {
  describe('matches direct "бот" references', () => {
    test('bare бот', () => expect(mentionsBot('бот, что сегодня?')).toBe(true));
    test('бот in the middle', () => expect(mentionsBot('эй бот покажи')).toBe(true));
    test('бота (genitive)', () => expect(mentionsBot('спросим бота')).toBe(true));
    test('боту (dative)', () => expect(mentionsBot('напишу боту')).toBe(true));
    test('ботом (instrumental)', () => expect(mentionsBot('поговори с ботом')).toBe(true));
    test('боте (prepositional)', () => expect(mentionsBot('в боте есть настройки')).toBe(true));
    test('боты (plural)', () => expect(mentionsBot('все боты так делают')).toBe(true));
    test('uppercase Бот', () => expect(mentionsBot('Бот сделай напоминание')).toBe(true));
    test('english bot', () => expect(mentionsBot('hey bot, help')).toBe(true));
    test('english bots', () => expect(mentionsBot('all bots are smart')).toBe(true));
    test('bot followed by punctuation', () => expect(mentionsBot('бот!')).toBe(true));
  });

  describe('does NOT match substrings inside other words', () => {
    test('ботинки (boots)', () => expect(mentionsBot('купил ботинки')).toBe(false));
    test('робот (robot)', () => expect(mentionsBot('робот идёт')).toBe(false));
    test('работа', () => expect(mentionsBot('сегодня много работы')).toBe(false));
    test('about', () => expect(mentionsBot('talk about this')).toBe(false));
    test('bottom', () => expect(mentionsBot('scroll to the bottom')).toBe(false));
    test('пот (sweat — phonetic clone of бот)', () => expect(mentionsBot('весь в поту')).toBe(false));
  });
});

describe('containsDateHint', () => {
  describe('numeric date formats', () => {
    test('DD.MM', () => expect(containsDateHint('встречаемся 15.04')).toBe(true));
    test('DD.MM.YYYY', () => expect(containsDateHint('встречаемся 15.04.2026')).toBe(true));
    test('DD.MM.YY', () => expect(containsDateHint('встречаемся 15.04.26')).toBe(true));
    test('DD/MM', () => expect(containsDateHint('see you 15/04')).toBe(true));
    test('DD-MM', () => expect(containsDateHint('на 15-04')).toBe(true));
    test('YYYY-MM-DD', () => expect(containsDateHint('event at 2026-04-15')).toBe(true));
    test('single-digit day/month', () => expect(containsDateHint('5.4 приду')).toBe(true));
  });

  describe('month name + day', () => {
    test('15 апреля', () => expect(containsDateHint('встреча 15 апреля')).toBe(true));
    test('15 апр', () => expect(containsDateHint('15 апр в кафе')).toBe(true));
    test('15 april', () => expect(containsDateHint('meeting on 15 april')).toBe(true));
    test('apr 15', () => expect(containsDateHint('apr 15 lunch')).toBe(true));
    test('march 3', () => expect(containsDateHint('see you march 3')).toBe(true));
    test('3 мая', () => expect(containsDateHint('концерт 3 мая')).toBe(true));
    test('октября 10', () => expect(containsDateHint('октября 10 приеду')).toBe(true));
  });

  describe('time of day', () => {
    test('HH:MM', () => expect(containsDateHint('в 15:30 встречаемся')).toBe(true));
    test('H:MM', () => expect(containsDateHint('в 9:00 начинаем')).toBe(true));
    test('at HH:MM', () => expect(containsDateHint('meet at 8:30')).toBe(true));
  });

  describe('does NOT match irrelevant patterns', () => {
    test('plain number', () => expect(containsDateHint('мне 25 лет')).toBe(false));
    test('version numbers', () => expect(containsDateHint('используем v1.2')).toBe(false));
    test('score', () => expect(containsDateHint('счёт 2:1 в нашу пользу')).toBe(false));
    test('random greeting', () => expect(containsDateHint('как дела?')).toBe(false));
    test('isolated month word (no day)', () => expect(containsDateHint('апрель уже близко')).toBe(false));
    test('word "may" without a day', () => expect(containsDateHint('i may go')).toBe(false));
  });
});

describe('isGroupRelevant', () => {
  const bot = 'MyCalBot';

  test('@mention triggers', () => expect(isGroupRelevant(`hello @${bot} help`, bot)).toBe(true));
  test('calendar address triggers', () => expect(isGroupRelevant('Календарь, что сегодня?', bot)).toBe(true));
  test('calendar address with typo triggers', () => expect(isGroupRelevant('Каледарь покажи', bot)).toBe(true));
  test('calendar keyword triggers', () => expect(isGroupRelevant('встреча завтра в 15:00', bot)).toBe(true));
  test('"бот" mention triggers', () => expect(isGroupRelevant('бот, помоги', bot)).toBe(true));
  test('numeric date triggers', () => expect(isGroupRelevant('давай 15.04 после работы', bot)).toBe(true));
  test('month+day triggers', () => expect(isGroupRelevant('давай 15 апреля', bot)).toBe(true));
  test('time triggers', () => expect(isGroupRelevant('в 19:30 подойду', bot)).toBe(true));
  test('unrelated small talk is ignored', () => expect(isGroupRelevant('как дела у тебя?', bot)).toBe(false));
  test('word "робот" alone is ignored', () => expect(isGroupRelevant('робот убирает в доме', bot)).toBe(false));
});
