// src/database/repositories/place-alias.repository.ts
import type { Database } from 'bun:sqlite';
import type { PlaceAlias } from '../types.ts';

/**
 * Search aliases for saved places (#655, migration 067_saved_places) — "Ушће" / `Ušće` /
 * `Usce park` for one place. Uniqueness is scoped to `place_id`, not `user_id`: two different
 * places owned by the same user MAY share an alias/label text (the design doc's own example:
 * "дом", "офис" are personal labels reused across places), so a lookup returning more than one
 * holder is a disambiguation case for the caller, never a write-time conflict.
 */
export class PlaceAliasRepository {
  constructor(private db: Database) {}

  listForPlace(userId: number, placeId: number): PlaceAlias[] {
    return this.db
      .prepare('SELECT * FROM place_aliases WHERE user_id = ? AND place_id = ? ORDER BY alias')
      .all(userId, placeId) as PlaceAlias[];
  }

  /** Every alias owned by the user, across all their places — used for fuzzy alias scoring. */
  listForUser(userId: number): PlaceAlias[] {
    return this.db.prepare('SELECT * FROM place_aliases WHERE user_id = ?').all(userId) as PlaceAlias[];
  }

  /** Done in JS, not SQL — SQLite's LOWER() is ASCII-only (Cyrillic case folds incorrectly). */
  findByAlias(userId: number, alias: string): PlaceAlias[] {
    const lower = alias.trim().toLowerCase();
    if (!lower) return [];
    const rows = this.db.prepare('SELECT * FROM place_aliases WHERE user_id = ?').all(userId) as PlaceAlias[];
    return rows.filter((row) => row.alias.trim().toLowerCase() === lower);
  }

  add(userId: number, placeId: number, alias: string): PlaceAlias {
    const trimmed = alias.trim();
    if (!trimmed) throw new Error('PLACE_ALIAS_EMPTY: alias must not be blank');
    const trimmedLower = trimmed.toLowerCase();
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT alias FROM place_aliases WHERE place_id = ?').all(placeId) as {
        alias: string;
      }[];
      if (existing.some((row) => row.alias.trim().toLowerCase() === trimmedLower)) {
        throw new Error('PLACE_ALIAS_CONFLICT: this place already has that alias');
      }
      const inserted = this.db
        .query<PlaceAlias, [number, number, string]>(
          'INSERT INTO place_aliases (user_id, place_id, alias) VALUES (?, ?, ?) RETURNING id, user_id, place_id, alias, created_at',
        )
        .get(userId, placeId, trimmed);
      if (!inserted) throw new Error('Place alias insert returned no row');
      return inserted;
    })();
  }

  delete(userId: number, placeId: number, aliasId: number): boolean {
    return (
      this.db
        .prepare('DELETE FROM place_aliases WHERE id = ? AND user_id = ? AND place_id = ?')
        .run(aliasId, userId, placeId).changes > 0
    );
  }
}
