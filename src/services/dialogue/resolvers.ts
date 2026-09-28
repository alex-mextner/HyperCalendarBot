// src/services/dialogue/resolvers.ts
//
// Typed injected resolver boundary for the operation fields whose values reference another
// domain object (a person, a place) rather than a plain literal (GH-652, design §23/§24).
// Published early so GH-654 (contacts/aliases/groups) and GH-655 (places) can implement a
// richer resolver against this exact interface instead of the dialogue runtime inventing its
// own contact/place shape, and so this slice never fakes contact/group data to look "done".
//
// - PeopleResolver's default implementation (`createContactPeopleResolver`) is backed by the
//   REAL, already-live `ContactRepository` (src/database/repositories/contact.repository.ts,
//   GH-654's territory but already merged/functional) — an exact (trim+lowercase) `name` match
//   is `exact`; ANY fuzzy match, even a single candidate, is `fuzzy` and must be confirmed
//   before use (design §23: "a single fuzzy contact match now requires explicit confirmation").
//   `contacts` today enforces a per-user UNIQUE(name) index, so two contacts can never share an
//   exact `name` — but a `preferred_name` has no such constraint, and GH-654's own household/
//   alias work may relax the `name` constraint too. This resolver does not trust the
//   repository's own first-match behavior for that: it independently checks `searchByName` for
//   more than one confidence-1.0 (exact-tier) candidate and treats a tie as `fuzzy` — so a
//   future duplicate name is a confirmation prompt, never a silent first-match pick.
// - `collective` is the typed extension point GH-654's exact-alias/collective-members feature
//   (e.g. an alias like "родители" naming two specific contacts) publishes against: ALL named
//   members resolve at once, never a choose-one prompt — a collective is, by definition, an
//   exact reference to more than one already-known person, not an ambiguous single-person
//   guess. `createContactPeopleResolver` never produces this today (no alias/group table
//   exists yet); the full-field parser (full-field-parser.ts) already understands the shape so
//   GH-654 only has to start returning it, not also change every consumer.
// - PlaceResolver's default implementation (`createManualPlaceResolver`) is the existing
//   manual-address-verbatim / native-Telegram-location behavior add-event.scene.ts already
//   has today (store the free-text address or the attached location's coordinates as-is, no
//   geocoding invented) — a real, functional path, not a stub that silently drops a place.
//   `resolveNative` rejects a non-finite or out-of-range coordinate pair (never accepts NaN/
//   Infinity or a latitude/longitude outside the physically valid range) rather than trusting
//   whatever a caller passes — GH-655 replaces/extends this resolver with saved places,
//   household links and geocoding behind this same interface.

import type { ContactRepository } from '../../database/repositories/contact.repository.ts';

export interface PersonCandidate {
  readonly contactId: number;
  readonly telegramId: number | null;
  readonly displayName: string;
  readonly confidence: number;
}

export type PersonResolution =
  | { kind: 'exact'; contactId: number | null; telegramId: number | null; displayName: string }
  | { kind: 'fuzzy'; candidates: readonly PersonCandidate[] }
  /** An exact alias/group naming more than one known person — every member resolves, never a choose-one prompt (see header comment; GH-654's extension point). */
  | { kind: 'collective'; members: readonly PersonCandidate[] }
  | { kind: 'none' };

export interface PeopleResolver {
  resolve(userId: number, rawName: string): PersonResolution;
}

export type PlaceResolution =
  | { kind: 'manual'; label: string }
  | { kind: 'native'; label: string; latitude: number; longitude: number }
  | { kind: 'unresolved' };

export interface NativeLocationInput {
  readonly latitude: number;
  readonly longitude: number;
  readonly title?: string;
  readonly address?: string;
}

export interface PlaceResolver {
  resolveManual(rawText: string): PlaceResolution;
  resolveNative(location: NativeLocationInput): PlaceResolution;
}

/** Real resolver backed by the live ContactRepository — exact vs. fuzzy per design §23. */
export function createContactPeopleResolver(contacts: ContactRepository): PeopleResolver {
  return {
    resolve(userId, rawName) {
      const strict = contacts.findByNameStrict(userId, rawName);
      const matches = contacts.searchByName(userId, rawName);
      const exactTier = matches.filter((m) => m.confidence === 1);
      // More than one exact-tier candidate (a duplicate `name`, or a `name` match tied with a
      // distinct contact's `preferred_name`) is ambiguous — never first-match, regardless of
      // what the strict lookup alone returned (see header comment).
      if (exactTier.length > 1) {
        return {
          kind: 'fuzzy',
          candidates: exactTier.map((m) => ({
            contactId: m.contact.id,
            telegramId: m.contact.telegram_id,
            displayName: m.contact.preferred_name ?? m.contact.name,
            confidence: m.confidence,
          })),
        };
      }
      if (strict) {
        return {
          kind: 'exact',
          contactId: strict.id,
          telegramId: strict.telegram_id,
          displayName: strict.preferred_name ?? strict.name,
        };
      }
      if (matches.length === 0) return { kind: 'none' };
      return {
        kind: 'fuzzy',
        candidates: matches.map((m) => ({
          contactId: m.contact.id,
          telegramId: m.contact.telegram_id,
          displayName: m.contact.preferred_name ?? m.contact.name,
          confidence: m.confidence,
        })),
      };
    },
  };
}

const MAX_LATITUDE = 90;
const MAX_LONGITUDE = 180;

function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= MAX_LATITUDE &&
    Math.abs(longitude) <= MAX_LONGITUDE
  );
}

/** Real manual/native place resolver — same behavior add-event.scene.ts already has for location. */
export function createManualPlaceResolver(): PlaceResolver {
  return {
    resolveManual(rawText) {
      const trimmed = rawText.trim();
      return trimmed.length > 0 ? { kind: 'manual', label: trimmed } : { kind: 'unresolved' };
    },
    resolveNative(location) {
      // A non-finite (NaN/Infinity) or out-of-range coordinate pair is never accepted as a
      // place — it cannot be geocoded, displayed on a map, or round-tripped through storage
      // (the DB column is a plain REAL with no range check of its own).
      if (!isValidCoordinate(location.latitude, location.longitude)) return { kind: 'unresolved' };
      const label = location.title ?? location.address ?? `${location.latitude},${location.longitude}`;
      return { kind: 'native', label, latitude: location.latitude, longitude: location.longitude };
    },
  };
}
