import { describe, expect, test } from 'bun:test';
import { createCookieString } from '../../packages/agent-macos/src/actions/cookie-parser.ts';

describe('createCookieString', () => {
  test('includes cookies with plain text value', () => {
    const rows = [{ host_key: '.claude.ai', name: 'session', value: 'abc123', encrypted_value: Buffer.alloc(0) }];
    const result = createCookieString(rows);
    expect(result).toBe('session=abc123');
  });

  test('skips cookies with no value and no encrypted_value', () => {
    const rows = [{ host_key: '.claude.ai', name: 'empty', value: '', encrypted_value: Buffer.alloc(0) }];
    const result = createCookieString(rows);
    expect(result).toBe('');
  });

  test('joins multiple cookies with semicolon', () => {
    const rows = [
      { host_key: '.claude.ai', name: 'a', value: '1', encrypted_value: Buffer.alloc(0) },
      { host_key: '.claude.ai', name: 'b', value: '2', encrypted_value: Buffer.alloc(0) },
    ];
    const result = createCookieString(rows);
    expect(result).toBe('a=1; b=2');
  });

  test('skips cookie with empty value when producing final string', () => {
    const rows = [
      { host_key: '.claude.ai', name: 'a', value: '1', encrypted_value: Buffer.alloc(0) },
      { host_key: '.claude.ai', name: 'b', value: '', encrypted_value: Buffer.alloc(0) },
      { host_key: '.claude.ai', name: 'c', value: '3', encrypted_value: Buffer.alloc(0) },
    ];
    const result = createCookieString(rows);
    expect(result).toBe('a=1; c=3');
  });

  test('returns empty string for empty rows array', () => {
    const result = createCookieString([]);
    expect(result).toBe('');
  });

  test('falls back to encrypted_value when value is empty but encrypted_value is non-v10', () => {
    // Non-v10 prefix with length >= 19: decryptCookieValue returns raw utf-8 string
    // Must be at least 19 bytes to pass the length guard
    const raw = Buffer.from('v11plaintext_padding_here', 'utf-8');
    const rows = [{ host_key: '.claude.ai', name: 'tok', value: '', encrypted_value: raw }];
    const result = createCookieString(rows);
    expect(result).toBe('tok=v11plaintext_padding_here');
  });
});
