// src/services/places/place-resolver.ts

import type { PlaceRepository } from '../../database/repositories/place.repository.ts';
import { scoreField } from '../../database/repositories/place.repository.ts';
import type { PlaceAliasRepository } from '../../database/repositories/place-alias.repository.ts';
import type { SavedPlace } from '../../database/types.ts';
import { phoneticNormalize } from '../../utils/fuzzy.ts';

export interface ResolvedPlaceMatch {
  place: SavedPlace;
  /** The alias/label text that matched, not necessarily the place's own label. */
  alias: string;
}

export interface ResolvedFuzzyPlaceMatch {
  place: SavedPlace;
  confidence: number;
}

/**
 * Typed contract for #655, mirroring ContactResolver's shape (#654): every caller (AI tools,
 * `/places`, and — once merged — GH-652's `PlaceResolver.resolveManual`/`resolveNative`
 * dialogue-v3 boundary) resolves a free-text place phrase through this single object.
 *
 *  - `exact_unique`   — one label/alias matched exactly one active place: use it, no geocoding.
 *  - `exact_ambiguous`— the same label/alias text is shared by more than one of the owner's
 *                       places (e.g. two places both aliased "дом"): the caller MUST ask the
 *                       user to pick one, never guess.
 *  - `fuzzy_confirm`  — no exact match, but a fuzzy candidate exists. Needs confirmation before
 *                       treating it as the intended place — design §10/§13's "never guess" rule.
 *  - `none`           — nothing matched; the caller falls back to a geocoder or asks for details.
 */
export type PlaceResolution =
  | { kind: 'none' }
  | { kind: 'exact_unique'; place: SavedPlace; matchedAlias: string }
  | { kind: 'exact_ambiguous'; candidates: ResolvedPlaceMatch[] }
  | { kind: 'fuzzy_confirm'; candidates: ResolvedFuzzyPlaceMatch[] };

export class PlaceResolver {
  constructor(
    private placeRepo: PlaceRepository,
    private placeAliasRepo: PlaceAliasRepository,
  ) {}

  resolve(userId: number, query: string): PlaceResolution {
    const trimmed = query.trim();
    if (!trimmed) return { kind: 'none' };

    const exact = this.resolveExact(userId, trimmed);
    if (exact) return exact;

    const fuzzy = this.fuzzySearch(userId, trimmed);
    if (fuzzy.length > 0) return { kind: 'fuzzy_confirm', candidates: fuzzy };

    return { kind: 'none' };
  }

  /**
   * Fuzzy-scores a place by its label/venue/address (PlaceRepository.searchByLabel) AND by every
   * alias it owns (a misspelled alias must surface a candidate just as readily as a misspelled
   * label — #655 parent review finding). A place scored by both keeps only its highest
   * confidence; never double-listed.
   */
  private fuzzySearch(userId: number, trimmed: string): ResolvedFuzzyPlaceMatch[] {
    const byPlace = new Map<number, ResolvedFuzzyPlaceMatch>();
    for (const match of this.placeRepo.searchByLabel(userId, trimmed)) byPlace.set(match.place.id, match);

    const queryLower = trimmed.toLowerCase();
    const normalizedQuery = phoneticNormalize(queryLower);
    for (const alias of this.placeAliasRepo.listForUser(userId)) {
      const confidence = scoreField(alias.alias, queryLower, normalizedQuery);
      if (confidence <= 0) continue;
      const existing = byPlace.get(alias.place_id);
      if (existing && existing.confidence >= confidence) continue;
      const place = this.placeRepo.findById(userId, alias.place_id);
      if (place) byPlace.set(alias.place_id, { place, confidence });
    }

    return [...byPlace.values()].sort(
      (a, b) => b.confidence - a.confidence || a.place.label.localeCompare(b.place.label, 'ru'),
    );
  }

  private resolveExact(userId: number, trimmed: string): PlaceResolution | null {
    const lower = trimmed.toLowerCase();
    const byLabel = this.placeRepo.list(userId).filter((place) => place.label.trim().toLowerCase() === lower);
    const aliasMatches = this.placeAliasRepo.findByAlias(userId, trimmed);

    const byPlace = new Map<number, string>();
    for (const place of byLabel) byPlace.set(place.id, place.label);
    for (const alias of aliasMatches) if (!byPlace.has(alias.place_id)) byPlace.set(alias.place_id, alias.alias);

    if (byPlace.size === 0) return null;
    if (byPlace.size === 1) {
      const [placeId, alias] = [...byPlace.entries()][0]!;
      const place = this.placeRepo.findById(userId, placeId);
      return place ? { kind: 'exact_unique', place, matchedAlias: alias } : null;
    }
    const candidates: ResolvedPlaceMatch[] = [];
    for (const [placeId, alias] of byPlace) {
      const place = this.placeRepo.findById(userId, placeId);
      if (place) candidates.push({ place, alias });
    }
    return candidates.length > 0 ? { kind: 'exact_ambiguous', candidates } : null;
  }
}
