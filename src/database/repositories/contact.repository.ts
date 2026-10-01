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

function normalizeUsername(username: string): string {
  return username.trim().replace(/^@/, '');
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
    const normalized = normalizeUsername(username);
    return this.db
      .prepare("SELECT * FROM contacts WHERE user_id = ? AND LOWER(LTRIM(TRIM(username), '@')) = LOWER(?)")
      .get(userId, normalized) as Contact | null;
  }

  list(userId: number): Contact[] {
    return this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(userId) as Contact[];
  }

  findById(userId: number, id: number): Contact | null {
    return this.db
      .query<Contact, [number, number]>(
        'SELECT id, user_id, name, username, telegram_id, preferred_name, created_at FROM contacts WHERE user_id = ? AND id = ?',
      )
      .get(userId, id);
  }

  upsert(userId: number, name: string, username?: string, telegramId?: number, preferredName?: string): Contact {
    return this.db.transaction(() => {
      const normalized = username ? normalizeUsername(username) : undefined;
      // Identity lookup precedes strict-name dedup; fuzzy matches never authorize a merge.
      const byId = telegramId ? this.findByTelegramId(userId, telegramId) : null;
      const byUsername = normalized ? this.findByUsername(userId, normalized) : null;
      if (byId && byUsername && byId.id !== byUsername.id) {
        throw new Error('CONTACT_IDENTITY_CONFLICT: ID and username identify different contacts');
      }
      const existing = byId ?? byUsername ?? this.findByNameStrict(userId, name);
      if (!existing) return this.add(userId, name, normalized, telegramId, preferredName);
      if (telegramId && existing.telegram_id && telegramId !== existing.telegram_id) {
        throw new Error('CONTACT_IDENTITY_CONFLICT: matching name or username has a different Telegram ID');
      }
      const sameId = telegramId !== undefined && telegramId === existing.telegram_id;
      if (
        normalized &&
        existing.username &&
        normalizeUsername(existing.username).toLowerCase() !== normalized.toLowerCase() &&
        !sameId
      ) {
        throw new Error('CONTACT_IDENTITY_CONFLICT: matching name has a different username');
      }
      const patch: { username?: string; telegram_id?: number; preferred_name?: string } = {};
      if (normalized && normalized !== existing.username) patch.username = normalized;
      if (telegramId) patch.telegram_id = telegramId;
      if (preferredName && !existing.preferred_name) patch.preferred_name = preferredName;
      if (Object.keys(patch).length > 0) this.update(existing.id, patch);
      return this.findById(userId, existing.id) ?? existing;
    })();
  }

  add(userId: number, name: string, username?: string, telegramId?: number, preferredName?: string): Contact {
    const inserted = this.db
      .query<Contact, [number, string, string | null, number | null, string | null]>(
        `INSERT INTO contacts (user_id, name, username, telegram_id, preferred_name) VALUES (?, ?, ?, ?, ?)
       RETURNING id, user_id, name, username, telegram_id, preferred_name, created_at`,
      )
      .get(userId, name, username ? normalizeUsername(username) : null, telegramId ?? null, preferredName ?? null);
    if (!inserted) throw new Error('Contact insert returned no row');
    return inserted;
  }

  update(id: number, patch: { name?: string; username?: string; telegram_id?: number; preferred_name?: string }): void {
    this.db.transaction(() => {
      const current = this.db.query<Contact, [number]>('SELECT * FROM contacts WHERE id = ?').get(id);
      if (!current) return;
      const usernameMatch = patch.username ? this.findByUsername(current.user_id, patch.username) : null;
      const idMatch = patch.telegram_id ? this.findByTelegramId(current.user_id, patch.telegram_id) : null;
      if ((usernameMatch && usernameMatch.id !== id) || (idMatch && idMatch.id !== id)) {
        throw new Error('CONTACT_IDENTITY_CONFLICT: update would merge two address-book identities');
      }
      if (
        current.telegram_id !== null &&
        patch.telegram_id !== undefined &&
        patch.telegram_id !== current.telegram_id
      ) {
        throw new Error('CONTACT_IDENTITY_CONFLICT: changing metadata cannot rebind an established Telegram ID');
      }
      const fields: string[] = [];
      const values: (string | number)[] = [];
      if (patch.name !== undefined) {
        fields.push('name = ?');
        values.push(patch.name);
      }
      if (patch.username !== undefined) {
        fields.push('username = ?');
        const normalized = normalizeUsername(patch.username);
        values.push(normalized);
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
    })();
  }

  refreshProfile(userId: number, telegramId: number, profile: { username: string | null; firstName?: string }): void {
    const username = profile.username ? normalizeUsername(profile.username) : null;
    this.db.transaction(() => {
      // Telegram can reassign usernames. Remove stale metadata, never move an ID.
      if (username)
        this.db
          .prepare(
            "UPDATE contacts SET username = NULL WHERE user_id = ? AND LOWER(LTRIM(TRIM(username), '@')) = LOWER(?) AND (telegram_id IS NULL OR telegram_id <> ?)",
          )
          .run(userId, username, telegramId);
      this.db
        .prepare('UPDATE contacts SET username = ? WHERE user_id = ? AND telegram_id = ?')
        .run(username, userId, telegramId);
    })();
  }

  deleteOwned(userId: number, id: number): boolean {
    return this.db.prepare('DELETE FROM contacts WHERE user_id = ? AND id = ?').run(userId, id).changes > 0;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  }
}
