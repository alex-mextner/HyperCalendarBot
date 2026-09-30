// src/database/repositories/place.repository.ts
import type { Database } from 'bun:sqlite';
import { levenshtein, maxEditDistance, phoneticNormalize } from '../../utils/fuzzy.ts';
import type { SavedPlace } from '../types.ts';

export interface CreatePlaceData {
  label: string;
  venueName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  provider?: string;
  providerPlaceId?: string;
  mapUrl?: string;
  notes?: string;
  /** Only 'confirmed' for a native pin/venue or an already-verified candidate — never a bare address. */
  verification?: 'unconfirmed' | 'confirmed';
  provenance?: string;
}

export interface UpdatePlaceData {
  label?: string;
  venueName?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  provider?: string | null;
  providerPlaceId?: string | null;
  mapUrl?: string | null;
  notes?: string | null;
  verification?: 'unconfirmed' | 'confirmed';
  provenance?: string | null;
}

export function scoreField(field: string | null, queryLower: string, normalizedQuery: string): number {
  if (!field || !normalizedQuery) return 0;
  const fieldLower = field.trim().toLowerCase();
  if (fieldLower === queryLower) return 1;
  const target = phoneticNormalize(fieldLower);
  if (!target) return 0;
  const dist = levenshtein(normalizedQuery, target);
  const maxLen = Math.max(normalizedQuery.length, target.length);
  if (dist > maxEditDistance(maxLen)) return 0;
  return Math.min(1 - dist / maxLen, 0.99);
}

function isValidLat(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLon(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

/** Throws unless every provided coordinate is a finite value inside its valid range. */
function assertValidCoords(latitude: number | null | undefined, longitude: number | null | undefined): void {
  if (latitude !== undefined && latitude !== null && !isValidLat(latitude)) {
    throw new Error('PLACE_COORDS_INVALID: latitude must be a finite number between -90 and 90');
  }
  if (longitude !== undefined && longitude !== null && !isValidLon(longitude)) {
    throw new Error('PLACE_COORDS_INVALID: longitude must be a finite number between -180 and 180');
  }
}

/**
 * The owner-scoped persistent place directory (#655, migration 067_saved_places). `label` is the
 * user's own name for the place ("дом", "офис", "Ушће"); coordinates/address are independent of
 * whether the place is `verification: 'confirmed'` — see `create()`. Redis `AddressCache` stays a
 * derived cache elsewhere in the codebase, never read or written here.
 */
export class PlaceRepository {
  constructor(private db: Database) {}

  findById(userId: number, id: number, opts: { includeDeleted?: boolean } = {}): SavedPlace | null {
    const row = this.db
      .prepare('SELECT * FROM saved_places WHERE id = ? AND user_id = ?')
      .get(id, userId) as SavedPlace | null;
    if (!row) return null;
    if (row.deleted_at !== null && !opts.includeDeleted) return null;
    return row;
  }

  /** Active (non-trashed) places, most recently updated first. */
  list(userId: number, opts: { favoriteOnly?: boolean } = {}): SavedPlace[] {
    const favoriteClause = opts.favoriteOnly ? ' AND favorite = 1' : '';
    return this.db
      .prepare(
        `SELECT * FROM saved_places WHERE user_id = ? AND deleted_at IS NULL${favoriteClause} ORDER BY favorite DESC, label`,
      )
      .all(userId) as SavedPlace[];
  }

  listTrash(userId: number): SavedPlace[] {
    return this.db
      .prepare('SELECT * FROM saved_places WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(userId) as SavedPlace[];
  }

  /**
   * Score every active place's label/venue_name/address against `query`, same phonetic/edit-
   * distance scoring as ContactRepository.searchByName — never used to auto-select a place, only
   * to rank candidates for the caller (or PlaceResolver) to present.
   */
  searchByLabel(userId: number, query: string): { place: SavedPlace; confidence: number }[] {
    const queryLower = query.trim().toLowerCase();
    if (!queryLower) return [];
    const normalizedQuery = phoneticNormalize(queryLower);
    const places = this.list(userId);
    const scored = places
      .map((place) => {
        const labelScore = scoreField(place.label, queryLower, normalizedQuery);
        const venueScore = scoreField(place.venue_name, queryLower, normalizedQuery);
        const addressScore = scoreField(place.address, queryLower, normalizedQuery);
        return { place, confidence: Math.max(labelScore, venueScore, addressScore) };
      })
      .filter((entry) => entry.confidence > 0);
    scored.sort((a, b) => b.confidence - a.confidence || a.place.label.localeCompare(b.place.label, 'ru'));
    return scored;
  }

  create(userId: number, data: CreatePlaceData): SavedPlace {
    const label = data.label.trim();
    if (!label) throw new Error('PLACE_LABEL_EMPTY: label must not be blank');
    assertValidCoords(data.latitude, data.longitude);
    const inserted = this.db
      .query<
        SavedPlace,
        [
          number,
          string,
          string | null,
          string | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          string | null,
          'unconfirmed' | 'confirmed',
          string | null,
        ]
      >(
        `INSERT INTO saved_places
           (user_id, label, venue_name, address, latitude, longitude, provider, provider_place_id, map_url, notes, verification, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        userId,
        label,
        data.venueName ?? null,
        data.address ?? null,
        data.latitude ?? null,
        data.longitude ?? null,
        data.provider ?? null,
        data.providerPlaceId ?? null,
        data.mapUrl ?? null,
        data.notes ?? null,
        data.verification ?? 'unconfirmed',
        data.provenance ?? null,
      );
    if (!inserted) throw new Error('Saved place insert returned no row');
    return inserted;
  }

  /**
   * Bumps `revision` and `updated_at` on every call. Per design §13: editing the address/
   * coordinates resets a place's verification to `unconfirmed` unless the caller explicitly
   * re-asserts `verification: 'confirmed'` in the same patch (a fresh native pin/candidate pick) —
   * renaming the label alone never re-triggers geocoding or touches verification.
   */
  update(userId: number, id: number, patch: UpdatePlaceData): SavedPlace | null {
    return this.db.transaction(() => {
      const current = this.findById(userId, id);
      if (!current) return null;
      const fields: string[] = [];
      const values: (string | number | null)[] = [];
      const touchesGeo = patch.address !== undefined || patch.latitude !== undefined || patch.longitude !== undefined;
      const trimmedLabel = patch.label !== undefined ? patch.label.trim() : undefined;
      if (trimmedLabel === '') throw new Error('PLACE_LABEL_EMPTY: label must not be blank');
      assertValidCoords(patch.latitude, patch.longitude);
      for (const [column, value] of [
        ['label', trimmedLabel],
        ['venue_name', patch.venueName],
        ['address', patch.address],
        ['latitude', patch.latitude],
        ['longitude', patch.longitude],
        ['provider', patch.provider],
        ['provider_place_id', patch.providerPlaceId],
        ['map_url', patch.mapUrl],
        ['notes', patch.notes],
        ['provenance', patch.provenance],
      ] as const) {
        if (value === undefined) continue;
        fields.push(`${column} = ?`);
        values.push(value);
      }
      const verification = patch.verification ?? (touchesGeo ? 'unconfirmed' : undefined);
      if (verification !== undefined) {
        fields.push('verification = ?');
        values.push(verification);
      }
      if (fields.length === 0) return current;
      fields.push('revision = revision + 1', "updated_at = datetime('now')");
      values.push(id, userId);
      this.db.prepare(`UPDATE saved_places SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`).run(...values);
      return this.findById(userId, id);
    })();
  }

  setFavorite(userId: number, id: number, favorite: boolean): boolean {
    return (
      this.db
        .prepare(
          "UPDATE saved_places SET favorite = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .run(favorite ? 1 : 0, id, userId).changes > 0
    );
  }

  softDelete(userId: number, id: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE saved_places SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .run(id, userId).changes > 0
    );
  }

  restore(userId: number, id: number): boolean {
    return (
      this.db
        .prepare('UPDATE saved_places SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
        .run(id, userId).changes > 0
    );
  }

  /** Permanent delete — only ever called after the place has already been soft-deleted. */
  purge(userId: number, id: number): boolean {
    return (
      this.db
        .prepare('DELETE FROM saved_places WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
        .run(id, userId).changes > 0
    );
  }
}
