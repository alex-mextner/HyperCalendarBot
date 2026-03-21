// Chromium stores cookies as plain text in the `value` column, or encrypted
// in `encrypted_value` (macOS: uses the system keychain). For claude.ai, plain
// text values are sufficient — the session cookie is stored as plain text.

export interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Buffer;
}

export function createCookieString(rows: CookieRow[]): string {
  return rows
    .filter((r) => r.value)
    .map((r) => `${r.name}=${r.value}`)
    .join('; ');
}
