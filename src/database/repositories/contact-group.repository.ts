// src/database/repositories/contact-group.repository.ts
import type { Database } from 'bun:sqlite';
import type { Contact, ContactGroup } from '../types.ts';

/**
 * Explicit collective aliases (#654, migration 066_contact_directory), e.g. "грюковы" resolving
 * to every member at once. Membership is always explicit — two contacts merely sharing an alias
 * text (see ContactAliasRepository) never auto-creates or auto-populates a group.
 *
 * Group aliases share the same per-user exact-match namespace as person aliases: `create()`
 * rejects an alias already used by a person alias so an exact lookup is never ambiguous between
 * "the person nicknamed X" and "the group named X".
 */
export class ContactGroupRepository {
  constructor(private db: Database) {}

  listGroups(userId: number): ContactGroup[] {
    return this.db
      .prepare('SELECT * FROM contact_groups WHERE user_id = ? ORDER BY alias')
      .all(userId) as ContactGroup[];
  }

  findById(userId: number, groupId: number): ContactGroup | null {
    return this.db
      .prepare('SELECT * FROM contact_groups WHERE id = ? AND user_id = ?')
      .get(groupId, userId) as ContactGroup | null;
  }

  /** Done in JS, not SQL — SQLite's LOWER() is ASCII-only (Cyrillic case folds incorrectly). */
  findByAlias(userId: number, alias: string): ContactGroup | null {
    const lower = alias.trim().toLowerCase();
    if (!lower) return null;
    const rows = this.db.prepare('SELECT * FROM contact_groups WHERE user_id = ?').all(userId) as ContactGroup[];
    return rows.find((row) => row.alias.trim().toLowerCase() === lower) ?? null;
  }

  create(userId: number, alias: string): ContactGroup {
    const trimmed = alias.trim();
    if (!trimmed) throw new Error('CONTACT_GROUP_ALIAS_EMPTY: group alias must not be blank');
    const lower = trimmed.toLowerCase();
    return this.db.transaction(() => {
      const groups = this.db.prepare('SELECT alias FROM contact_groups WHERE user_id = ?').all(userId) as {
        alias: string;
      }[];
      if (groups.some((row) => row.alias.trim().toLowerCase() === lower)) {
        throw new Error('CONTACT_GROUP_ALIAS_CONFLICT: a group with that alias already exists');
      }
      this.assertNoPersonAliasCollision(userId, lower);
      const inserted = this.db
        .query<ContactGroup, [number, string]>(
          'INSERT INTO contact_groups (user_id, alias) VALUES (?, ?) RETURNING id, user_id, alias, created_at',
        )
        .get(userId, trimmed);
      if (!inserted) throw new Error('Contact group insert returned no row');
      return inserted;
    })();
  }

  /**
   * Same collision policy as `create()` — a rename must not land a group onto an existing
   * person alias either: that would leave the person's alias exact-matchable while the
   * resolver's group branch (checked first) now also matches the same text, making the two
   * ambiguous in exactly the way the shared namespace exists to prevent.
   */
  rename(userId: number, groupId: number, newAlias: string): void {
    const trimmed = newAlias.trim();
    if (!trimmed) throw new Error('CONTACT_GROUP_ALIAS_EMPTY: group alias must not be blank');
    const lower = trimmed.toLowerCase();
    this.db.transaction(() => {
      const existing = this.findById(userId, groupId);
      if (!existing) throw new Error('CONTACT_GROUP_NOT_FOUND: group does not belong to this user');
      const groups = this.db.prepare('SELECT id, alias FROM contact_groups WHERE user_id = ?').all(userId) as {
        id: number;
        alias: string;
      }[];
      if (groups.some((row) => row.id !== groupId && row.alias.trim().toLowerCase() === lower)) {
        throw new Error('CONTACT_GROUP_ALIAS_CONFLICT: a group with that alias already exists');
      }
      this.assertNoPersonAliasCollision(userId, lower);
      this.db.prepare('UPDATE contact_groups SET alias = ? WHERE id = ?').run(trimmed, groupId);
    })();
  }

  private assertNoPersonAliasCollision(userId: number, lowerAlias: string): void {
    const personAliases = this.db.prepare('SELECT alias FROM contact_aliases WHERE user_id = ?').all(userId) as {
      alias: string;
    }[];
    if (personAliases.some((row) => row.alias.trim().toLowerCase() === lowerAlias)) {
      throw new Error('CONTACT_GROUP_ALIAS_CONFLICT: that alias already names a person in your contacts');
    }
  }

  delete(userId: number, groupId: number): boolean {
    return this.db.prepare('DELETE FROM contact_groups WHERE id = ? AND user_id = ?').run(groupId, userId).changes > 0;
  }

  addMember(userId: number, groupId: number, contactId: number): void {
    this.db.transaction(() => {
      const group = this.findById(userId, groupId);
      if (!group) throw new Error('CONTACT_GROUP_NOT_FOUND: group does not belong to this user');
      const owned = this.db.prepare('SELECT 1 FROM contacts WHERE id = ? AND user_id = ?').get(contactId, userId);
      if (!owned) throw new Error('CONTACT_GROUP_MEMBER_NOT_OWNED: contact does not belong to this user');
      this.db
        .prepare('INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)')
        .run(groupId, contactId);
    })();
  }

  removeMember(userId: number, groupId: number, contactId: number): boolean {
    const group = this.findById(userId, groupId);
    if (!group) return false;
    return (
      this.db.prepare('DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?').run(groupId, contactId)
        .changes > 0
    );
  }

  listMembers(userId: number, groupId: number): Contact[] {
    return this.db
      .prepare(
        `SELECT c.* FROM contacts c
         JOIN contact_group_members m ON m.contact_id = c.id
         JOIN contact_groups g ON g.id = m.group_id
         WHERE g.id = ? AND g.user_id = ? AND c.user_id = ?
         ORDER BY c.name`,
      )
      .all(groupId, userId, userId) as Contact[];
  }
}
