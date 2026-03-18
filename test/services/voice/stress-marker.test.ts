import { describe, expect, test } from 'bun:test';
import { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
} from '../../../src/services/voice/stress-marker.ts';

describe('markStress', () => {
  const dict = new StressDictionary({
    привет: 'прив+ет',
    встреча: 'встр+еча',
    сегодня: 'сег+одня',
    часа: 'час+а',
  });

  test('replaces known words with stressed forms', () => {
    expect(markStress('привет', dict)).toBe('прив+ет');
    expect(markStress('встреча сегодня', dict)).toBe('встр+еча сег+одня');
  });

  test('preserves punctuation and spacing', () => {
    expect(markStress('привет! встреча, сегодня.', dict)).toBe('прив+ет! встр+еча, сег+одня.');
  });

  test('preserves uppercase first letter', () => {
    expect(markStress('Привет', dict)).toBe('Прив+ет');
    expect(markStress('Встреча в три часа', dict)).toBe('Встр+еча в три час+а');
  });

  test('leaves unknown words unchanged', () => {
    expect(markStress('Алексом', dict)).toBe('Алексом');
    expect(markStress('привет Алексом', dict)).toBe('прив+ет Алексом');
  });
});

describe('numbersToWords', () => {
  test('converts time HH:MM', () => {
    expect(numbersToWords('в 15:00')).toBe('в пятн+адцать');
    expect(numbersToWords('в 9:30')).toBe('в д+евять тр+идцать');
  });

  test('converts standalone numbers', () => {
    expect(numbersToWords('через 5 минут')).toBe('через пять минут');
    expect(numbersToWords('100 событий')).toBe('сто событий');
  });

  test('leaves non-number text unchanged', () => {
    expect(numbersToWords('привет мир')).toBe('привет мир');
  });
});

describe('fixDateOrdinals', () => {
  test('converts day+month to ordinal form', () => {
    expect(fixDateOrdinals('17 марта')).toBe('семнадцатого марта');
    expect(fixDateOrdinals('1 января')).toBe('первого января');
    expect(fixDateOrdinals('31 декабря')).toBe('тридцать первого декабря');
    expect(fixDateOrdinals('21 апреля')).toBe('двадцать первого апреля');
  });

  test('does not change standalone numbers', () => {
    expect(fixDateOrdinals('встреча в 17:00')).toBe('встреча в 17:00');
    expect(fixDateOrdinals('позови 5 человек')).toBe('позови 5 человек');
  });
});

describe('fixLineBreaks', () => {
  test('converts double newlines to period+space', () => {
    expect(fixLineBreaks('строка одна\n\nстрока два')).toBe('строка одна. строка два');
  });

  test('converts single newlines to comma+space', () => {
    expect(fixLineBreaks('строка одна\nстрока два')).toBe('строка одна, строка два');
  });

  test('does not duplicate punctuation before newline', () => {
    expect(fixLineBreaks('хорошо.\nстрока два')).toBe('хорошо. строка два');
    expect(fixLineBreaks('хорошо!\nстрока два')).toBe('хорошо! строка два');
  });
});

describe('stripMarkdown', () => {
  test('removes bold and italic', () => {
    expect(stripMarkdown('**bold** and *italic*')).toBe('bold and italic');
  });

  test('removes code', () => {
    expect(stripMarkdown('use `code` here')).toBe('use code here');
  });

  test('removes links', () => {
    expect(stripMarkdown('[text](http://url)')).toBe('text');
  });

  test('removes headers', () => {
    expect(stripMarkdown('## Title\nBody')).toBe('Title\nBody');
  });

  test('collapses excessive newlines', () => {
    expect(stripMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });
});
