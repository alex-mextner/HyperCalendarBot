// src/database/repositories/place-role.repository.ts
import type { Database } from 'bun:sqlite';
import type { PlaceRole, PlaceRoleName, PlaceRoleOwnerType, SavedPlace } from '../types.ts';

/** owner_ref_id is required for 'contact'/'group', absent (stored as 0) for 'self'. */
export interface PlaceRoleOwner {
  ownerType: PlaceRoleOwnerType;
  ownerRefId?: number;
}

function refId(owner: PlaceRoleOwner): number {
  if (owner.ownerType === 'self') return 0;
  if (owner.ownerRefId === undefined) throw new Error('PLACE_ROLE_OWNER_REF_REQUIRED: ownerRefId is required');
  return owner.ownerRefId;
}

/**
 * Home/work role bindings (#655, migration 067_saved_places, design §24) — a link to a
 * `saved_places` row, never a copy of its address. One mechanism covers the owner's own home/work
 * (`ownerType: 'self'`), a contact-bound place like "Lena's home" (`ownerType: 'contact'`, a
 * private note of the requesting owner — never published, never requires the other person's
 * consent), and a household's agreed shared home (`ownerType: 'group'`, e.g. #654's collective
 * aliases). At most one place per (role, ownerType, ownerRefId) — `set()` replaces any existing
 * link for that key rather than creating a second one.
 */
export class PlaceRoleRepository {
  constructor(private db: Database) {}

  /** Links `placeId` as `role` for `owner`, replacing whatever it previously pointed to. */
  set(userId: number, role: PlaceRoleName, owner: PlaceRoleOwner, placeId: number): PlaceRole {
    const ownerRefId = refId(owner);
    return this.db.transaction(() => {
      const place = this.db
        .prepare('SELECT 1 FROM saved_places WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
        .get(placeId, userId);
      if (!place) throw new Error('PLACE_ROLE_PLACE_NOT_FOUND: place does not belong to this user');
      if (owner.ownerType === 'contact') {
        const contact = this.db.prepare('SELECT 1 FROM contacts WHERE id = ? AND user_id = ?').get(ownerRefId, userId);
        if (!contact) throw new Error('PLACE_ROLE_OWNER_NOT_FOUND: contact does not belong to this user');
      } else if (owner.ownerType === 'group') {
        const group = this.db
          .prepare('SELECT 1 FROM contact_groups WHERE id = ? AND user_id = ?')
          .get(ownerRefId, userId);
        if (!group) throw new Error('PLACE_ROLE_OWNER_NOT_FOUND: group does not belong to this user');
      }
      this.db
        .prepare('DELETE FROM place_roles WHERE user_id = ? AND role = ? AND owner_type = ? AND owner_ref_id = ?')
        .run(userId, role, owner.ownerType, ownerRefId);
      const inserted = this.db
        .query<PlaceRole, [number, number, string, string, number]>(
          `INSERT INTO place_roles (user_id, place_id, role, owner_type, owner_ref_id) VALUES (?, ?, ?, ?, ?)
           RETURNING id, user_id, place_id, role, owner_type, owner_ref_id, created_at`,
        )
        .get(userId, placeId, role, owner.ownerType, ownerRefId);
      if (!inserted) throw new Error('Place role insert returned no row');
      return inserted;
    })();
  }

  /**
   * The place currently linked, or `null` if unset — never guesses. A role whose linked place
   * was soft-deleted resolves to `null` too: a trashed place cannot be anyone's active home/work.
   */
  getPlace(userId: number, role: PlaceRoleName, owner: PlaceRoleOwner): SavedPlace | null {
    const ownerRefId = refId(owner);
    return this.db
      .prepare(
        `SELECT sp.* FROM place_roles pr
         JOIN saved_places sp ON sp.id = pr.place_id
         WHERE pr.user_id = ? AND pr.role = ? AND pr.owner_type = ? AND pr.owner_ref_id = ?
           AND sp.deleted_at IS NULL`,
      )
      .get(userId, role, owner.ownerType, ownerRefId) as SavedPlace | null;
  }

  clear(userId: number, role: PlaceRoleName, owner: PlaceRoleOwner): boolean {
    const ownerRefId = refId(owner);
    return (
      this.db
        .prepare('DELETE FROM place_roles WHERE user_id = ? AND role = ? AND owner_type = ? AND owner_ref_id = ?')
        .run(userId, role, owner.ownerType, ownerRefId).changes > 0
    );
  }

  listForPlace(userId: number, placeId: number): PlaceRole[] {
    return this.db
      .prepare('SELECT * FROM place_roles WHERE user_id = ? AND place_id = ?')
      .all(userId, placeId) as PlaceRole[];
  }
}
