import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { decryptBlob, decryptString, encryptBlob, encryptString } from '../../../src/services/crypto/session-crypto.ts';

describe('session-crypto', () => {
  const masterKey = randomBytes(32);

  test('encryptBlob → decryptBlob roundtrip preserves data', () => {
    const original = randomBytes(4096);
    const encrypted = encryptBlob(original, masterKey);
    const decrypted = decryptBlob(encrypted, masterKey);
    expect(decrypted).toEqual(original);
  });

  test('encrypted blob overhead = IV (12) + tag (16)', () => {
    const original = Buffer.from('short');
    const encrypted = encryptBlob(original, masterKey);
    expect(encrypted.length).toBe(original.length + 12 + 16);
  });

  test('random IV — identical plaintext produces different ciphertext', () => {
    const original = Buffer.from('test-data');
    const enc1 = encryptBlob(original, masterKey);
    const enc2 = encryptBlob(original, masterKey);
    expect(enc1).not.toEqual(enc2);
  });

  test('tampered ciphertext throws on decrypt (GCM auth tag)', () => {
    const original = Buffer.from('secret');
    const encrypted = encryptBlob(original, masterKey);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    encrypted[20] = encrypted[20]! ^ 0xff;
    expect(() => decryptBlob(encrypted, masterKey)).toThrow();
  });

  test('wrong key throws on decrypt', () => {
    const encrypted = encryptBlob(Buffer.from('secret'), masterKey);
    const wrongKey = randomBytes(32);
    expect(() => decryptBlob(encrypted, wrongKey)).toThrow();
  });

  test('empty buffer roundtrip', () => {
    const original = Buffer.alloc(0);
    const encrypted = encryptBlob(original, masterKey);
    expect(decryptBlob(encrypted, masterKey)).toEqual(original);
  });

  test('encryptString / decryptString roundtrip (UTF-8)', () => {
    const phone = '+79001234567';
    const encrypted = encryptString(phone, masterKey);
    expect(decryptString(encrypted, masterKey)).toBe(phone);
  });

  test('encryptString handles unicode', () => {
    const encrypted = encryptString('🔐 секрет', masterKey);
    expect(decryptString(encrypted, masterKey)).toBe('🔐 секрет');
  });
});
