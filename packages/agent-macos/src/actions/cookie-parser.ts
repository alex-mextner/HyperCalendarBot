import { execSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

export interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer;
}

export interface DecryptedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number; // Unix timestamp in seconds
}

let cachedMasterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;
  const password = execSync(
    'security find-generic-password -s "Claude Safe Storage" -a "Claude Key" -w 2>/dev/null || ' +
      'security find-generic-password -s "Chrome Safe Storage" -a "Chrome" -w 2>/dev/null || ' +
      'security find-generic-password -s "Chromium Safe Storage" -a "Chromium" -w 2>/dev/null || ' +
      'echo "peanuts"',
    { encoding: 'utf-8' },
  ).trim();
  cachedMasterKey = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  return cachedMasterKey;
}

export function decryptCookieValue(encryptedValue: Buffer): string {
  if (!encryptedValue || encryptedValue.length < 4) return '';
  const prefix = encryptedValue.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10') return encryptedValue.toString('utf-8');

  // Chromium macOS v10 format: v10 (3 bytes) + IV (16 bytes) + AES-128-CBC ciphertext
  // Chromium prepends a 16-byte random nonce to the plaintext before encryption,
  // so the first 16 decrypted bytes must be skipped to get the actual cookie value.
  if (encryptedValue.length < 35) return '';
  const iv = encryptedValue.subarray(3, 19);
  const ciphertext = encryptedValue.subarray(19);
  const key = getMasterKey();

  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // Skip the 16-byte nonce prefix that Chromium prepends to every plaintext
    return decrypted.subarray(16).toString('utf-8');
  } catch {
    return '';
  }
}

export function createCookieString(rows: CookieRow[]): string {
  return rows
    .map((r) => {
      const value =
        r.value || (r.encrypted_value?.length ? decryptCookieValue(r.encrypted_value) : '');
      return value ? `${r.name}=${value}` : null;
    })
    .filter((s): s is string => s !== null)
    .join('; ');
}

export function loadDecryptedCookies(cookiesPath: string): DecryptedCookie[] {
  // Import here to avoid top-level require at module load time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(cookiesPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, is_secure, is_httponly, expires_utc
         FROM cookies WHERE host_key LIKE '%claude.ai%'`,
      )
      .all() as Array<{
        host_key: string;
        name: string;
        value: string;
        encrypted_value: Buffer;
        path: string;
        is_secure: number;
        is_httponly: number;
        expires_utc: number;
      }>;

    return rows
      .map((r) => {
        const value = r.value || (r.encrypted_value?.length ? decryptCookieValue(r.encrypted_value) : '');
        // Chrome stores expires_utc in microseconds since Windows epoch (1601-01-01)
        // Convert to Unix seconds: divide by 1e6, subtract Windows-to-Unix offset
        const expirationDate =
          r.expires_utc > 0
            ? Math.floor(r.expires_utc / 1_000_000) - 11_644_473_600
            : undefined;
        return {
          name: r.name,
          value,
          domain: r.host_key,
          path: r.path || '/',
          secure: r.is_secure === 1,
          httpOnly: r.is_httponly === 1,
          expirationDate,
        };
      })
      .filter((c) => c.value.length > 0);
  } finally {
    db.close();
  }
}
