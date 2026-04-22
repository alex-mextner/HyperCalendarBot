import type { Database } from 'bun:sqlite';
import { levenshtein, maxEditDistance, phoneticNormalize } from '../../utils/fuzzy.ts';
import type { Contact } from '../types.ts';

function scoreField(field: string | null, queryLower: string, normalizedQuery: string): number {
  if (!field || !normalizedQuery) return 0;
  // Strict (trim+lowerCase) equality is the ONLY path that scores 1.0 — it guarantees
  // the user typed exactly this name. Anything below goes through phonetic collapse,
  // which loses information (e.g. "Вова"/"Фофа" phonetic-tie), so we cap at 0.99.
  const fieldLower = field.trim().toLowerCase();
  if (fieldLower === queryLower) return 1;
  const target = phoneticNormalize(fieldLower);
  if (!target) return 0;
  const dist = levenshtein(normalizedQuery, target);
  const maxLen = Math.max(normalizedQuery.length, target.length);
  if (dist > maxEditDistance(maxLen)) return 0;
  return Math.min(1 - dist / maxLen, 0.99);
}

export class ContactRepository {
  constructor(private db: Database) {}

  findByName(userId: number, name: string): Contact | null {
    return this.searchByName(userId, name)[0]?.contact ?? null;
  }

  /**
   * Strict-equality lookup: matches only when `name` and the stored `name` are
   * equal after TRIM + toLowerCase on both sides. Used by `upsert` for dedup so
   * phonetic collapse (e.g. "Вова"/"Фофа" → same) does NOT silently merge
   * distinct people. Never returns a fuzzy match.
   *
   * Done in JS (not SQL) because SQLite's built-in LOWER() is ASCII-only —
   * "Лена" stays "Лена", breaking Cyrillic case-insensitive comparison.
   */
  findByNameStrict(userId: number, name: string): Contact | null {
    const lower = name.trim().toLowerCase();
    if (lower.length === 0) return null;
    const contacts = this.db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(userId) as Contact[];
    return contacts.find((c) => c.name.trim().toLowerCase() === lower) ?? null;
  }

  /**
   * Return every contact whose name or preferred_name matches `name`, scored 0..1.
   * Strict (trim+lowerCase) exact match is checked before phonetic normalization
   * to preserve distinctions like "Вова" vs "Фофа" that phonetic collapse erases.
   * Falls back to Levenshtein distance on phonetically-normalized forms,
   * capped by maxEditDistance (see src/utils/fuzzy.ts).
   * Sorted by confidence desc, then by name asc for stable ordering.
   */
  searchByName(userId: number, name: string): { contact: Contact; confidence: number }[] {
    const queryLower = name.trim().toLowerCase();
    if (queryLower.length === 0) return [];
    // queryLower is already trim+lowerCase; phoneticNormalize collapses further
    // (ё=е, voiced→voiceless pairs, soft signs, duplicate chars). Both sides of
    // the later Levenshtein compare are run through this same normalization.
    const normalizedQuery = phoneticNormalize(queryLower);
    if (!normalizedQuery) return [];
    const contacts = this.db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(userId) as Contact[];

    const scored: { contact: Contact; confidence: number }[] = [];
    for (const c of contacts) {
      const score = Math.max(
        scoreField(c.name, queryLower, normalizedQuery),
        scoreField(c.preferred_name, queryLower, normalizedQuery),
      );
      if (score > 0) scored.push({ contact: c, confidence: score });
    }
    scored.sort((a, b) => b.confidence - a.confidence || a.contact.name.localeCompare(b.contact.name, 'ru'));
    return scored;
  }

  findByTelegramId(userId: number, contactTelegramId: number): Contact | null {
    return this.db
      .prepare('SELECT * FROM contacts WHERE user_id = ? AND telegram_id = ?')
      .get(userId, contactTelegramId) as Contact | null;
  }

  findByUsername(userId: number, username: string): Contact | null {
    const normalized = username.startsWith('@') ? username.slice(1) : username;
    return this.db
      .prepare('SELECT * FROM contacts WHERE user_id = ? AND LOWER(username) = LOWER(?)')
      .get(userId, normalized) as Contact | null;
  }

  list(userId: number): Contact[] {
    return this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(userId) as Contact[];
  }

  upsert(userId: number, name: string, username?: string, telegramId?: number, preferredName?: string): Contact {
    // Dedup: telegram_id → username → strict name. NEVER use fuzzy `findByName`
    // here — phonetic collapse would merge "Вова" with a freshly-added "Фофа".
    const existing =
      (telegramId ? this.findByTelegramId(userId, telegramId) : null) ??
      (username ? this.findByUsername(userId, username) : null) ??
      this.findByNameStrict(userId, name);

    if (existing) {
      const patch: { name?: string; username?: string; telegram_id?: number; preferred_name?: string } = {};
      if (username && !existing.username) patch.username = username;
      if (telegramId && !existing.telegram_id) patch.telegram_id = telegramId;
      if (preferredName && !existing.preferred_name) patch.preferred_name = preferredName;
      if (Object.keys(patch).length > 0) this.update(existing.id, patch);
      return this.findByNameStrict(userId, existing.name) ?? existing;
    }

    return this.add(userId, name, username, telegramId, preferredName);
  }

  add(userId: number, name: string, username?: string, telegramId?: number, preferredName?: string): Contact {
    this.db
      .prepare('INSERT INTO contacts (user_id, name, username, telegram_id, preferred_name) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, username ?? null, telegramId ?? null, preferredName ?? null);
    return this.findByNameStrict(userId, name)!;
  }

  update(id: number, patch: { name?: string; username?: string; telegram_id?: number; preferred_name?: string }): void {
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      values.push(patch.name);
    }
    if (patch.username !== undefined) {
      fields.push('username = ?');
      values.push(patch.username);
    }
    if (patch.telegram_id !== undefined) {
      fields.push('telegram_id = ?');
      values.push(patch.telegram_id);
    }
    if (patch.preferred_name !== undefined) {
      fields.push('preferred_name = ?');
      values.push(patch.preferred_name);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  }
}
