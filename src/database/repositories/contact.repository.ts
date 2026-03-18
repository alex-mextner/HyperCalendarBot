import type { Database } from 'bun:sqlite';

export interface Contact {
  id: number;
  user_id: number;
  name: string;
  username: string | null;
  telegram_id: number | null;
  preferred_name: string | null;
  created_at: string;
}

export class ContactRepository {
  constructor(private db: Database) {}

  findByName(userId: number, name: string): Contact | null {
    const lower = name.toLowerCase();
    const contacts = this.db.prepare('SELECT * FROM contacts WHERE user_id = ?').all(userId) as Contact[];
    return (
      contacts.find((c) => c.name.toLowerCase() === lower || (c.preferred_name?.toLowerCase() ?? '') === lower) ?? null
    );
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
    // Dedup: check by telegram_id first, then username, then name
    const existing =
      (telegramId ? this.findByTelegramId(userId, telegramId) : null) ??
      (username ? this.findByUsername(userId, username) : null) ??
      this.findByName(userId, name);

    if (existing) {
      const patch: { name?: string; username?: string; telegram_id?: number; preferred_name?: string } = {};
      if (username && !existing.username) patch.username = username;
      if (telegramId && !existing.telegram_id) patch.telegram_id = telegramId;
      if (preferredName && !existing.preferred_name) patch.preferred_name = preferredName;
      if (Object.keys(patch).length > 0) this.update(existing.id, patch);
      return this.findByName(userId, existing.name) ?? existing;
    }

    return this.add(userId, name, username, telegramId, preferredName);
  }

  add(userId: number, name: string, username?: string, telegramId?: number, preferredName?: string): Contact {
    this.db
      .prepare('INSERT INTO contacts (user_id, name, username, telegram_id, preferred_name) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, username ?? null, telegramId ?? null, preferredName ?? null);
    return this.findByName(userId, name)!;
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
