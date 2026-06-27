import { describe, expect, test } from 'bun:test';
import {
  escapeHtml,
  escapeMarkdown,
  formatUtcOffset,
  markdownToHtml,
  splitMessage,
  stripHtml,
  truncateMessage,
} from '../../src/utils/telegram.ts';

describe('escapeHtml', () => {
  test('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
  test('escapes angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });
  test('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });
  test('escapes all special characters together', () => {
    expect(escapeHtml('<a href="url">R&D</a>')).toBe('&lt;a href=&quot;url&quot;&gt;R&amp;D&lt;/a&gt;');
  });
  test('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });
  test('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('truncateMessage', () => {
  test('returns short text unchanged', () => {
    expect(truncateMessage('hello')).toBe('hello');
  });
  test('returns text exactly at limit unchanged', () => {
    const text = 'a'.repeat(4000);
    expect(truncateMessage(text)).toBe(text);
  });
  test('truncates text exceeding default limit', () => {
    const text = 'a'.repeat(4001);
    const result = truncateMessage(text);
    expect(result.length).toBe(4000);
    expect(result.endsWith('...')).toBe(true);
  });
  test('truncates text exceeding custom limit', () => {
    const text = 'abcdefghij';
    const result = truncateMessage(text, 7);
    expect(result).toBe('abcd...');
    expect(result.length).toBe(7);
  });
  test('returns empty string unchanged', () => {
    expect(truncateMessage('')).toBe('');
  });
});

describe('escapeMarkdown', () => {
  test('escapes underscores in usernames', () => {
    expect(escapeMarkdown('@larichkina_b')).toBe('@larichkina\\_b');
  });
  test('escapes asterisks', () => {
    expect(escapeMarkdown('2*3=6')).toBe('2\\*3=6');
  });
  test('escapes backticks', () => {
    expect(escapeMarkdown('use `code` here')).toBe('use \\`code\\` here');
  });
  test('escapes square brackets', () => {
    expect(escapeMarkdown('[link](url)')).toBe('\\[link\\](url)');
  });
  test('escapes a literal backslash so it cannot neutralize the next escape', () => {
    expect(escapeMarkdown('a\\_b')).toBe('a\\\\\\_b');
  });
  test('escapes multiple special characters together', () => {
    expect(escapeMarkdown('_bold_ and *italic* [link]')).toBe('\\_bold\\_ and \\*italic\\* \\[link\\]');
  });
  test('returns plain text unchanged', () => {
    expect(escapeMarkdown('hello world')).toBe('hello world');
  });
  test('returns empty string unchanged', () => {
    expect(escapeMarkdown('')).toBe('');
  });
});

describe('stripHtml', () => {
  test('removes simple tags and decodes entities', () => {
    expect(stripHtml('<b>hi</b> &amp; bye')).toBe('hi & bye');
  });
  test('removes nested tags', () => {
    expect(stripHtml('<b><i>x</i></b>')).toBe('x');
  });
  test('is idempotent (stable at the fixpoint)', () => {
    const once = stripHtml('<a href="x">y</a>');
    expect(stripHtml(once)).toBe(once);
  });
  test('returns plain text unchanged', () => {
    expect(stripHtml('hello world')).toBe('hello world');
  });
});

describe('splitMessage', () => {
  test('returns single-element array for short text', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });
  test('returns single-element array for text at limit', () => {
    const text = 'a'.repeat(4000);
    expect(splitMessage(text)).toEqual([text]);
  });
  test('splits at paragraph boundary', () => {
    const para1 = 'a'.repeat(3000);
    const para2 = 'b'.repeat(3000);
    const text = `${para1}\n\n${para2}`;
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });
  test('splits at line boundary when paragraph is too long', () => {
    const line1 = 'a'.repeat(1500);
    const line2 = 'b'.repeat(1500);
    const line3 = 'c'.repeat(1500);
    const text = `${line1}\n${line2}\n${line3}`;
    const result = splitMessage(text);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(`${line1}\n${line2}`);
    expect(result[1]).toBe(line3);
  });
  test('hard splits when no natural boundary fits', () => {
    const text = 'a'.repeat(8000);
    const result = splitMessage(text, 4000);
    expect(result.length).toBe(2);
    expect(result[0]!.length).toBe(4000);
    expect(result[1]!.length).toBe(4000);
  });
  test('returns empty string in array for empty input', () => {
    expect(splitMessage('')).toEqual(['']);
  });
  test('handles custom maxLen', () => {
    const text = 'aaa\n\nbbb\n\nccc';
    const result = splitMessage(text, 7);
    expect(result).toEqual(['aaa', 'bbb', 'ccc']);
  });
  test('each chunk respects maxLen', () => {
    const text = 'a'.repeat(12345);
    const result = splitMessage(text, 4000);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    expect(result.join('')).toBe(text);
  });
});

describe('markdownToHtml', () => {
  test('converts **bold** to <b>', () => {
    expect(markdownToHtml('**hello**')).toBe('<b>hello</b>');
  });
  test('converts *italic* to <i>', () => {
    expect(markdownToHtml('*hello*')).toBe('<i>hello</i>');
  });
  test('converts _italic_ to <i>', () => {
    expect(markdownToHtml('_hello_')).toBe('<i>hello</i>');
  });
  test('converts `code` to <code>', () => {
    expect(markdownToHtml('use `code` here')).toBe('use <code>code</code> here');
  });
  test('escapes HTML entities', () => {
    expect(markdownToHtml('<script>')).toBe('&lt;script&gt;');
  });
  test('handles **bold** and *italic* together', () => {
    expect(markdownToHtml('**bold** and *italic*')).toBe('<b>bold</b> and <i>italic</i>');
  });
  test('does not break _underscores_ in middle of words', () => {
    expect(markdownToHtml('@larichkina_b')).toBe('@larichkina_b');
  });
  test('handles plain text unchanged', () => {
    expect(markdownToHtml('hello world')).toBe('hello world');
  });
});

describe('formatUtcOffset', () => {
  test('formats UTC timezone', () => {
    const result = formatUtcOffset('UTC');
    expect(result).toBe('UTC');
  });
  test('formats positive offset timezone', () => {
    const result = formatUtcOffset('Europe/Moscow');
    expect(result).toMatch(/^UTC\+3$/);
  });
  test('formats negative offset timezone', () => {
    const result = formatUtcOffset('America/New_York');
    expect(result).toMatch(/^UTC[−-]\d+$/);
  });
  test('formats timezone with half-hour offset', () => {
    const result = formatUtcOffset('Asia/Kolkata');
    expect(result).toMatch(/^UTC\+5:30$/);
  });
});
