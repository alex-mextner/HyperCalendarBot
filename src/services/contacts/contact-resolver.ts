// src/services/contacts/contact-resolver.ts

import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { ContactAliasRepository } from '../../database/repositories/contact-alias.repository.ts';
import type { ContactGroupRepository } from '../../database/repositories/contact-group.repository.ts';
import type { Contact, ContactAlias, ContactGroup } from '../../database/types.ts';

export interface ResolvedContactMatch {
  contact: Contact;
  /** The alias/name text that matched, not necessarily the contact's primary name. */
  alias: string;
}

export interface ResolvedFuzzyMatch {
  contact: Contact;
  confidence: number;
}

/**
 * Typed contract published for #654/#655: HcbRuntime652's natural-language commit flow, the
 * `/contacts` command, and the AI `resolve_contact` tool all resolve a free-text name/alias
 * through this single object — same precedence, same disambiguation rules everywhere.
 *
 *  - `exact_unique`   — one alias/name matched exactly one contact: use it, no question asked.
 *  - `exact_ambiguous`— the same alias/name text is shared by more than one of the owner's
 *                       contacts (a real duplicate-name collision, e.g. two "Lena"s):
 *                       the caller MUST ask the user to pick one, never guess.
 *  - `exact_group`    — the text is an explicit collective alias (e.g. "грюковы"): expands to
 *                       every current member with NO per-member confirmation. Two contacts merely
 *                       sharing an alias never reaches this branch — collective membership is
 *                       always an explicit group the user created, never inferred from a coincidence.
 *  - `fuzzy_confirm`  — no exact match, but a fuzzy candidate exists. ALWAYS needs confirmation,
 *                       even with exactly one candidate — call `confirmFuzzyMatch` after the user
 *                       agrees so the correction is learned as an alias for next time.
 *  - `none`           — nothing matched.
 */
export type ContactResolution =
  | { kind: 'none' }
  | { kind: 'exact_unique'; contact: Contact; matchedAlias: string }
  | { kind: 'exact_ambiguous'; candidates: ResolvedContactMatch[] }
  | { kind: 'exact_group'; group: ContactGroup; members: Contact[] }
  | { kind: 'fuzzy_confirm'; candidates: ResolvedFuzzyMatch[] };

export class ContactResolver {
  constructor(
    private contactRepo: ContactRepository,
    private aliasRepo: ContactAliasRepository,
    private groupRepo: ContactGroupRepository,
  ) {}

  /**
   * Resolution order: explicit collective group first (its namespace is checked before person
   * aliases so an exact match is never ambiguous between "the group" and "a person nicknamed
   * that"), then exact person alias/name (unique vs ambiguous), then fuzzy.
   */
  resolve(userId: number, query: string): ContactResolution {
    const trimmed = query.trim();
    if (!trimmed) return { kind: 'none' };

    const group = this.groupRepo.findByAlias(userId, trimmed);
    if (group) return { kind: 'exact_group', group, members: this.groupRepo.listMembers(userId, group.id) };

    const exact = this.resolveExactAlias(userId, trimmed);
    if (exact) return exact;

    const fuzzy = this.contactRepo.searchByName(userId, trimmed);
    if (fuzzy.length > 0) return { kind: 'fuzzy_confirm', candidates: fuzzy };

    return { kind: 'none' };
  }

  private resolveExactAlias(userId: number, trimmed: string): ContactResolution | null {
    const aliasMatches = this.aliasRepo.findByAlias(userId, trimmed);
    if (aliasMatches.length === 0) return null;
    const byContact = new Map<number, ContactAlias>();
    for (const match of aliasMatches) byContact.set(match.contact_id, match);
    if (byContact.size === 1) {
      const alias = [...byContact.values()][0]!;
      const contact = this.contactRepo.findById(userId, alias.contact_id);
      return contact ? { kind: 'exact_unique', contact, matchedAlias: alias.alias } : null;
    }
    const candidates: ResolvedContactMatch[] = [];
    for (const alias of byContact.values()) {
      const contact = this.contactRepo.findById(userId, alias.contact_id);
      if (contact) candidates.push({ contact, alias: alias.alias });
    }
    return candidates.length > 0 ? { kind: 'exact_ambiguous', candidates } : null;
  }

  /**
   * Records a user-confirmed fuzzy match as a learned alias (provenance: `confirmed_correction`)
   * so the same phrasing resolves exactly next time. Silently accepts an alias the contact
   * already holds — confirming twice is not an error.
   */
  confirmFuzzyMatch(userId: number, contactId: number, alias: string): void {
    try {
      this.aliasRepo.add(userId, contactId, alias, 'confirmed_correction');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONTACT_ALIAS_CONFLICT:')) return;
      throw error;
    }
  }
}
