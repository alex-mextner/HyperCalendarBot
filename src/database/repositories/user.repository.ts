// src/database/repositories/user.repository.ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { CreateUserData, UpdateUserData, User } from '../types.ts';

export class UserRepository {
  constructor(private db: Database) {}

  findByTelegramId(telegramId: number): User | null {
    return this.db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | null;
  }

  findByUsername(username: string): User | null {
    const normalized = username.startsWith('@') ? username.slice(1) : username;
    return this.db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(normalized) as User | null;
  }

  create(data: CreateUserData): User {
    this.db
      .prepare(`
      INSERT INTO users (telegram_id, username, first_name, language, timezone, country_code)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.telegram_id,
        data.username ?? null,
        data.first_name ?? null,
        data.language ?? 'en',
        data.timezone ?? 'UTC',
        data.country_code ?? null,
      );
    return this.findByTelegramId(data.telegram_id)!;
  }

  findOrCreate(data: CreateUserData): User {
    const existing = this.findByTelegramId(data.telegram_id);
    if (existing) {
      if (data.username !== undefined || data.first_name !== undefined) {
        const updates: UpdateUserData = {};
        if (data.username !== undefined && data.username !== existing.username) {
          updates.username = data.username;
        }
        if (data.first_name !== undefined && data.first_name !== existing.first_name) {
          updates.first_name = data.first_name;
        }
        if (Object.keys(updates).length > 0) {
          return this.update(data.telegram_id, updates)!;
        }
      }
      return existing;
    }
    return this.create(data);
  }

  updateGoogleToken(telegramId: number, encRefreshToken: string): void {
    this.db
      .prepare(`
      UPDATE users SET google_refresh_token_enc = ?, updated_at = datetime('now')
      WHERE telegram_id = ?
    `)
      .run(encRefreshToken, telegramId);
  }

  clearGoogleToken(telegramId: number): void {
    this.db
      .prepare(`
      UPDATE users SET
        google_refresh_token_enc = NULL,
        google_calendar_id = NULL,
        updated_at = datetime('now')
      WHERE telegram_id = ?
    `)
      .run(telegramId);
  }

  update(telegramId: number, data: UpdateUserData): User | null {
    const existing = this.findByTelegramId(telegramId);
    if (!existing) return null;

    const ALLOWED_COLUMNS = new Set([
      'username',
      'first_name',
      'language',
      'timezone',
      'country_code',
      'onboarding_completed',
    ]);
    const fields: string[] = [];
    const values: SQLQueryBindings[] = [];

    for (const [key, value] of Object.entries(data)) {
      if (!ALLOWED_COLUMNS.has(key)) continue;
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(telegramId);

    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE telegram_id = ?`).run(...values);

    return this.findByTelegramId(telegramId)!;
  }
}
