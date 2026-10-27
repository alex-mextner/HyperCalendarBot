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

describe('splitMessage (HTML mode)', () => {
  const split = (text: string, maxLen: number) => splitMessage(text, maxLen, 'HTML');

  test('returns text within the limit unchanged, even with unbalanced tags', () => {
    expect(split('<b>open', 100)).toEqual(['<b>open']);
    expect(split('', 5)).toEqual(['']);
  });

  test('hard-splits plain text at exactly maxLen', () => {
    expect(split('a'.repeat(10), 4)).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  test('does not break an escaped entity across chunks', () => {
    expect(split('aaa&amp;bbb', 6)).toEqual(['aaa', '&amp;b', 'bb']);
    expect(split('aa&#1234;bb', 8)).toEqual(['aa', '&#1234;b', 'b']);
    expect(split('aa&#x1F600;bb', 10)).toEqual(['aa', '&#x1F600;b', 'b']);
  });

  test('does not break a Unicode code point across chunks', () => {
    expect(split('😀😀😀', 4)).toEqual(['😀😀', '😀']);
  });

  test('treats a stray "<" or "&" as a literal character', () => {
    expect(split('a < b & c', 5)).toEqual(['a < b', ' & c']);
  });

  test('closes open tags at a cut and reopens them in the next chunk', () => {
    expect(split('<b>aaaaaa</b>', 10)).toEqual(['<b>aaa</b>', '<b>aaa</b>']);
  });

  test('reopens a tag with its original attributes', () => {
    expect(split('<a href="u">aaaaaaaa</a>', 20)).toEqual(['<a href="u">aaaa</a>', '<a href="u">aaaa</a>']);
  });

  test('reopens nested tags outermost-first and closes them innermost-first', () => {
    const chunks = split('<b><i>xxxxxxxxxx</i></b>', 16);
    expect(chunks).toEqual(Array.from({ length: 5 }, () => '<b><i>xx</i></b>'));
  });

  test('every chunk fits maxLen and the visible text is preserved', () => {
    const text = `<b>${'bold '.repeat(30)}</b> plain &lt;tag&gt; <i>${'ital '.repeat(30)}</i> 😀 tail`;
    const chunks = split(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    // The tag pass of stripHtml (same regex, to a fixpoint so no `<script` fragment survives) without
    // its entity decoding: the assertion needs `&lt;tag&gt;` to stay visible text.
    const visible = (html: string) => {
      let stripped = html;
      let prev: string;
      do {
        prev = stripped;
        stripped = stripped.replace(/<[^>]*>/g, '');
      } while (stripped !== prev);
      return stripped;
    };
    expect(chunks.map(visible).join('')).toBe(visible(text));
  });

  test('a closing tag without an opening tag costs nothing and is kept', () => {
    expect(split('</i>abcdef', 6)).toEqual(['</i>ab', 'cdef']);
  });

  test('throws when an open tag cannot fit with its closing tag in a chunk', () => {
    expect(() => split('<b>xxxxxxxx</b>', 6)).toThrow('HTML tag exceeds message chunk capacity');
  });

  test('throws when a single tag is longer than maxLen', () => {
    expect(() => split('<a href="https://example.com/very/long">x</a>', 20)).toThrow(
      'HTML tag exceeds message chunk capacity',
    );
  });

  test('throws when reopened tags leave no room for the next token', () => {
    expect(() => split('<b><i>xxxxxxxx</i></b>', 11)).toThrow('HTML tag exceeds message chunk capacity');
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
  test('collapses zero offset to bare UTC', () => {
    // Some ICU builds render shortOffset for UTC as 'GMT+0' instead of 'GMT'.
    // The result must be exactly 'UTC' regardless, never 'UTC+0' / 'UTC-0'.
    expect(formatUtcOffset('Etc/UTC')).toBe('UTC');
  });
  test('keeps the offset for non-zero timezones', () => {
    const result = formatUtcOffset('Europe/Belgrade');
    expect(result).toMatch(/^UTC[+-]\d/);
  });
});
