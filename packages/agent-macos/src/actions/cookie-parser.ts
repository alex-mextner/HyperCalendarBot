import { execSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

export interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer;
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
  if (!encryptedValue || encryptedValue.length < 19) return '';
  const prefix = encryptedValue.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10') return encryptedValue.toString('utf-8');

  const iv = encryptedValue.subarray(3, 19);
  const ciphertext = encryptedValue.subarray(19);
  const key = getMasterKey();

  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
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
