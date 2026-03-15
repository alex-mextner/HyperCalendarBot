import { describe, expect, test } from 'bun:test';
import { escapeHtml, formatUtcOffset, truncateMessage } from '../../src/utils/telegram.ts';

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
