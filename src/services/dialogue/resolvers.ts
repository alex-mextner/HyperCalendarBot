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
//   GH-654's territory but already merged/functional) — an exact name/username/telegram-id
//   match is `exact`; ANY fuzzy match, even a single candidate, is `fuzzy` and must be
//   confirmed before use (design §23: "a single fuzzy contact match now requires explicit
//   confirmation"). Alias/group expansion is GH-654's own extension of this interface, not
//   implemented here.
// - PlaceResolver's default implementation (`createManualPlaceResolver`) is the existing
//   manual-address-verbatim / native-Telegram-location behavior add-event.scene.ts already
//   has today (store the free-text address or the attached location's coordinates as-is, no
//   geocoding invented) — a real, functional path, not a stub that silently drops a place.
//   GH-655 replaces/extends it with saved places, household links and geocoding behind this
//   same interface.

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
      if (strict) {
        return {
          kind: 'exact',
          contactId: strict.id,
          telegramId: strict.telegram_id,
          displayName: strict.preferred_name ?? strict.name,
        };
      }
      const matches = contacts.searchByName(userId, rawName);
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

/** Real manual/native place resolver — same behavior add-event.scene.ts already has for location. */
export function createManualPlaceResolver(): PlaceResolver {
  return {
    resolveManual(rawText) {
      const trimmed = rawText.trim();
      return trimmed.length > 0 ? { kind: 'manual', label: trimmed } : { kind: 'unresolved' };
    },
    resolveNative(location) {
      const label = location.title ?? location.address ?? `${location.latitude},${location.longitude}`;
      return { kind: 'native', label, latitude: location.latitude, longitude: location.longitude };
    },
  };
}
