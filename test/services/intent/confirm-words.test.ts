// Natural yes/no answers to a «Да / Отмена» question: a plain yes confirms, a plain no declines, and anything that
// qualifies a yes ("да но завтра") is neither, so no write runs on a reply that means something else.
import { describe, expect, test } from 'bun:test';
import { confirmationChoice } from '../../../src/services/intent/confirm-words.ts';

const OPTIONS = ['Да', 'Отмена'] as const;
const choose = (answer: string) => confirmationChoice(answer, OPTIONS);

describe('confirmationChoice', () => {
  test.each([
    'да',
    'Да!',
    'ок',
    'yes',
    'давай',
    'конечно',
    'да пожалуйста',
    'yes please',
    'ок спасибо',
    'да да',
  ])('a plain yes confirms: %s', (answer) => expect(choose(answer)).toBe('Да'));

  test.each([
    'нет',
    'отмена',
    'не надо',
    'no',
    'cancel',
    'не создавай',
    'нет спасибо',
  ])('a plain no declines: %s', (answer) => expect(choose(answer)).toBe('Отмена'));

  test.each([
    'давай позже',
    'да но завтра',
    'ок а лучше в пятницу',
    'yes but later',
    'да только в пять',
    'maybe later',
  ])('a qualified or unrelated reply is neither yes nor no: %s', (answer) => expect(choose(answer)).toBeUndefined());

  test('a second option that is not a refusal is never selected by "нет"', () => {
    expect(confirmationChoice('нет', ['Да', 'Позже'])).toBeUndefined();
    expect(confirmationChoice('да', ['Да', 'Позже'])).toBeUndefined();
    expect(confirmationChoice('no', ['Yes', 'Cancel'])).toBe('Cancel');
  });

  test('a reply that mixes both senses is never a yes', () => {
    expect(choose('да нет')).toBe('Отмена');
    expect(choose('ок отмени')).toBe('Отмена');
  });

  test('only a two-option yes/cancel question is interpreted', () => {
    expect(confirmationChoice('да', ['Да', 'Нет', 'Позже'])).toBeUndefined();
    expect(confirmationChoice('да', ['Первый', 'Второй'])).toBeUndefined();
  });
});
