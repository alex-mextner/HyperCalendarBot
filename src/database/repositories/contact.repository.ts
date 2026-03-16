import type { Database } from 'bun:sqlite';

export interface Contact {
  id: number;
  user_id: number;
  name: string;
  username: string | null;
  telegram_id: number | null;
  created_at: string;
}

export class ContactRepository {
  constructor(private db: Database) {}

  findByName(userId: number, name: string): Contact | null {
    return this.db
      .prepare('SELECT * FROM contacts WHERE user_id = ? AND LOWER(name) = LOWER(?)')
      .get(userId, name) as Contact | null;
  }

  list(userId: number): Contact[] {
    return this.db.prepare('SELECT * FROM contacts WHERE user_id = ? ORDER BY name').all(userId) as Contact[];
  }

  add(userId: number, name: string, username?: string, telegramId?: number): Contact {
    this.db
      .prepare('INSERT INTO contacts (user_id, name, username, telegram_id) VALUES (?, ?, ?, ?)')
      .run(userId, name, username ?? null, telegramId ?? null);
    return this.findByName(userId, name)!;
  }

  update(id: number, patch: { name?: string; username?: string; telegram_id?: number }): void {
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
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
  }
}
