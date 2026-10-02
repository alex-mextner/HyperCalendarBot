import { createHash, randomBytes } from 'node:crypto';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** SHA-256 of key-sorted JSON, so equal content always hashes equally. */
export function stableHash(value: unknown): string {
  return sha256(JSON.stringify(stable(value)));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Opaque bearer secret handed to a worker; only its hash is stored. */
export function newLeaseToken(): string {
  return randomBytes(32).toString('base64url');
}
