import { describe, expect, test } from 'bun:test';
import { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';
import { markStress, stripMarkdown } from '../../../src/services/voice/stress-marker.ts';

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
