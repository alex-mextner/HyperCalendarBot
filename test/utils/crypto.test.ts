import { describe, expect, test } from 'bun:test';
import { decrypt, encrypt } from '../../src/utils/crypto.ts';

describe('crypto', () => {
  const key = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'; // 64 hex chars

  test('encrypt returns iv:authTag:ciphertext format', () => {
    const encrypted = encrypt('hello world', key);
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
  });

  test('decrypt reverses encrypt', () => {
    const plaintext = 'my-secret-refresh-token-12345';
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test('different encryptions produce different ciphertexts (random IV)', () => {
    const plaintext = 'same-text';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
  });

  test('decrypt with wrong key throws', () => {
    const encrypted = encrypt('secret', key);
    const wrongKey = 'b'.repeat(64);
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  test('decrypt with tampered ciphertext throws', () => {
    const encrypted = encrypt('secret', key);
    const parts = encrypted.split(':');
    parts[2] = `AAAA${parts[2]!.slice(4)}`;
    expect(() => decrypt(parts.join(':'), key)).toThrow();
  });

  test('handles empty string', () => {
    const encrypted = encrypt('', key);
    expect(decrypt(encrypted, key)).toBe('');
  });

  test('handles unicode', () => {
    const text = 'Привет мир 🌍';
    const encrypted = encrypt(text, key);
    expect(decrypt(encrypted, key)).toBe(text);
  });
});
