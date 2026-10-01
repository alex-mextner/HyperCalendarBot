// src/database/repositories/contact-alias.repository.ts
import type { Database } from 'bun:sqlite';
import type { ContactAlias, ContactAliasSource } from '../types.ts';

/**
 * Person aliases (#654, migration 066_contact_directory). `contacts.name` mirrors whichever
 * alias is currently primary — see `promote()`. Uniqueness is scoped to `contact_id`, NOT
 * `user_id`: two different contacts owned by the same user are explicitly allowed to share an
 * alias/name (real-world duplicate names), so a lookup returning more than one holder is a
 * disambiguation case for the caller, never a write-time conflict.
 */
export class ContactAliasRepository {
  constructor(private db: Database) {}

  listForContact(userId: number, contactId: number): ContactAlias[] {
    return this.db
      .prepare('SELECT * FROM contact_aliases WHERE user_id = ? AND contact_id = ? ORDER BY is_primary DESC, alias')
      .all(userId, contactId) as ContactAlias[];
  }

  /**
   * Every alias (across all of the owner's contacts) matching `alias` case-insensitively.
   * Done in JS, not SQL: SQLite's built-in LOWER() is ASCII-only (same reasoning as
   * ContactRepository.findByNameStrict) — Cyrillic aliases must fold case in JS or two
   * differently-cased spellings of the same alias silently fail to match.
   */
  findByAlias(userId: number, alias: string): ContactAlias[] {
    const lower = alias.trim().toLowerCase();
    if (!lower) return [];
    const rows = this.db.prepare('SELECT * FROM contact_aliases WHERE user_id = ?').all(userId) as ContactAlias[];
    return rows.filter((row) => row.alias.trim().toLowerCase() === lower);
  }

  /**
   * The exact-match namespace is shared with contact_groups (see ContactGroupRepository's own
   * doc comment) — checked in both directions: group creation rejects a name already used by a
   * person alias, and this rejects an alias already used by a group. Without both directions an
   * alias added after a same-named group exists would be silently and permanently shadowed by
   * that group at exact-match resolution time (ContactResolver checks groups first).
   */
  add(userId: number, contactId: number, alias: string, source: ContactAliasSource): ContactAlias {
    const trimmed = alias.trim();
    if (!trimmed) throw new Error('CONTACT_ALIAS_EMPTY: alias must not be blank');
    const trimmedLower = trimmed.toLowerCase();
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT alias FROM contact_aliases WHERE contact_id = ?').all(contactId) as {
        alias: string;
      }[];
      if (existing.some((row) => row.alias.trim().toLowerCase() === trimmedLower)) {
        throw new Error('CONTACT_ALIAS_CONFLICT: this contact already has that alias');
      }
      const groups = this.db.prepare('SELECT alias FROM contact_groups WHERE user_id = ?').all(userId) as {
        alias: string;
      }[];
      if (groups.some((row) => row.alias.trim().toLowerCase() === trimmedLower)) {
        throw new Error('CONTACT_ALIAS_CONFLICT: that alias already names a group in your contacts');
      }
      const inserted = this.db
        .query<ContactAlias, [number, number, string, ContactAliasSource]>(
          `INSERT INTO contact_aliases (user_id, contact_id, alias, is_primary, source) VALUES (?, ?, ?, 0, ?)
           RETURNING id, user_id, contact_id, alias, is_primary, source, created_at`,
        )
        .get(userId, contactId, trimmed, source);
      if (!inserted) throw new Error('Contact alias insert returned no row');
      return inserted;
    })();
  }

  /**
   * Sets `aliasId` as the contact's primary alias and mirrors its text onto `contacts.name`.
   *
   * Display contract (GH-654 confirmed blocker): `contacts.preferred_name`, when set, overrides
   * `name` everywhere the UI and the AI tools compute a display label (`preferred_name ?? name`).
   * any stale `preferred_name` override — otherwise the promotion has no visible effect. The old
   * override is not silently discarded: unless it already exists as an alias (case-insensitive),
   * matches the alias being promoted, or collides with an existing group's alias (the same
   * cross-namespace check `add()` enforces — see its doc comment), it is inserted as a new
   * non-primary alias, so it stays reachable. A group-name collision is the one case it is
   * dropped rather than inserted: promote() is a best-effort preservation, not an identity merge,
   * and it must never create an alias that would be immediately shadowed by a same-named group at
   * exact-match resolution time.
   */
  promote(userId: number, contactId: number, aliasId: number): void {
    this.db.transaction(() => {
      const target = this.db
        .prepare('SELECT * FROM contact_aliases WHERE id = ? AND user_id = ? AND contact_id = ?')
        .get(aliasId, userId, contactId) as ContactAlias | null;
      if (!target) throw new Error('CONTACT_ALIAS_NOT_FOUND: alias does not belong to this contact');
      if (target.is_primary === 1) return;
      const owner = this.db
        .prepare('SELECT preferred_name FROM contacts WHERE id = ? AND user_id = ?')
        .get(contactId, userId) as { preferred_name: string | null } | undefined;
      const stalePreferred = owner?.preferred_name?.trim() ?? '';
      if (stalePreferred && stalePreferred.toLowerCase() !== target.alias.trim().toLowerCase()) {
        const alreadyAliased = this.db
          .prepare('SELECT id FROM contact_aliases WHERE contact_id = ? AND LOWER(alias) = LOWER(?)')
          .get(contactId, stalePreferred);
        const shadowedByGroup = this.db
          .prepare('SELECT id FROM contact_groups WHERE user_id = ? AND LOWER(alias) = LOWER(?)')
          .get(userId, stalePreferred);
        if (!alreadyAliased && !shadowedByGroup) {
          this.db
            .prepare(
              "INSERT INTO contact_aliases (user_id, contact_id, alias, is_primary, source) VALUES (?, ?, ?, 0, 'manual')",
            )
            .run(userId, contactId, stalePreferred);
        }
      }
      this.db.prepare('UPDATE contact_aliases SET is_primary = 0 WHERE contact_id = ?').run(contactId);
      this.db.prepare('UPDATE contact_aliases SET is_primary = 1 WHERE id = ?').run(aliasId);
      this.db
        .prepare('UPDATE contacts SET name = ?, preferred_name = NULL WHERE id = ? AND user_id = ?')
        .run(target.alias, contactId, userId);
    })();
  }

  /** Never removes the primary alias — promote a different one first. Returns false if not found/owned. */
  delete(userId: number, contactId: number, aliasId: number): boolean {
    return this.db.transaction(() => {
      const target = this.db
        .prepare('SELECT * FROM contact_aliases WHERE id = ? AND user_id = ? AND contact_id = ?')
        .get(aliasId, userId, contactId) as ContactAlias | null;
      if (!target) return false;
      if (target.is_primary === 1)
        throw new Error('CONTACT_ALIAS_PRIMARY: promote another alias before deleting this one');
      this.db.prepare('DELETE FROM contact_aliases WHERE id = ?').run(aliasId);
      return true;
    })();
  }
}
