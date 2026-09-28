import { t } from '../../../config/constants.ts';
import type { ContactRepository } from '../../../database/repositories/contact.repository.ts';
import type { Contact, ContactAlias, ContactGroup } from '../../../database/types.ts';
import { canResolveRecipientUsername } from '../recipient-identity.ts';
import { inspectRecipientProfile } from '../recipient-profile.ts';
import type { AgentContext, ContactMatch, ToolHandlerMeta, ToolResult, UserInspection } from '../types.ts';

const MAX_CONTACT_MATCHES = 5;
/** contact_id and telegram_id are both bare integers in tool output; only telegram_id addresses a person. */
function recipientIdHint(contacts: { telegram_id: number | null }[]): string {
  const hint = 'contact_id is an address-book row, never a Telegram ID: invitee_id takes telegram_id.';
  return contacts.some((contact) => contact.telegram_id === null)
    ? `${hint} telegram_id: none means no linked Telegram account: invite via its saved @username, else pick_users.`
    : hint;
}

type RankedContact = { contact: Contact; confidence: number };

function toContactMatch(contact: Contact, confidence: number): ContactMatch {
  return {
    id: contact.id,
    name: contact.name,
    preferred_name: contact.preferred_name,
    username: contact.username,
    telegram_id: contact.telegram_id,
    confidence,
    created_at: contact.created_at,
  };
}

function formatContactFields(contact: Contact): string {
  const parts = [`contact_id: ${contact.id}`, `name: ${contact.name}`, `created_at_utc: ${contact.created_at}`];
  if (contact.preferred_name) parts.push(`preferred_name: ${contact.preferred_name}`);
  if (contact.username) parts.push(`username: @${contact.username}`);
  parts.push(`telegram_id: ${contact.telegram_id ?? 'none'}`);
  return parts.join(', ');
}

function confidenceLabel(confidence: number): string {
  return confidence >= 1 ? 'exact' : `${Math.round(confidence * 100)}%`;
}

function formatContactMatchLine(match: ContactMatch): string {
  const parts = [`contact_id: ${match.id}`, `name: ${match.name}`];
  if (match.created_at) parts.push(`created_at_utc: ${match.created_at}`);
  if (match.preferred_name) parts.push(`preferred_name: ${match.preferred_name}`);
  if (match.username) parts.push(`username: @${match.username}`);
  parts.push(`telegram_id: ${match.telegram_id ?? 'none'}`);
  return `- ${parts.join(', ')} (${confidenceLabel(match.confidence)})`;
}

function searchContactsRanked(contactRepo: ContactRepository, userId: number, rawQuery: string): RankedContact[] {
  if (/^\d+$/.test(rawQuery.trim())) {
    const id = Number(rawQuery.trim());
    const contact = Number.isSafeInteger(id) ? contactRepo.findByTelegramId(userId, id) : null;
    return contact ? [{ contact, confidence: 1 }] : [];
  }
  const nameQuery = rawQuery.startsWith('@') ? rawQuery.slice(1) : rawQuery;
  const byId = new Map<number, RankedContact>();
  for (const match of contactRepo.searchByName(userId, nameQuery)) {
    byId.set(match.contact.id, match);
  }
  const usernameMatch = contactRepo.findByUsername(userId, nameQuery);
  if (usernameMatch) {
    const existing = byId.get(usernameMatch.id);
    if (!existing || existing.confidence < 1) {
      byId.set(usernameMatch.id, { contact: usernameMatch, confidence: 1 });
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.confidence - a.confidence || a.contact.name.localeCompare(b.contact.name, 'ru'))
    .slice(0, MAX_CONTACT_MATCHES);
}

export function handleGetContacts(ctx: AgentContext, input: { force?: boolean }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup && !input.force) {
    return {
      success: false,
      error:
        "get_contacts exposes the user's private contact list. In a group this would reveal personal data to all members. Use ask_user to clarify what the user wants first. Only call get_contacts with force: true after the user explicitly confirmed they want their private contacts shown in the group.",
    };
  }
  const contacts = ctx.contactRepo.list(ctx.user.telegram_id);
  const lang = ctx.user.language;
  if (contacts.length === 0) return { success: true, output: t(lang).aiTools.meta.addressBookEmpty };
  const lines = contacts.map((c) => {
    const parts = [c.preferred_name ?? c.name, `contact_id:${c.id}`, `created_at_utc:${c.created_at}`];
    if (c.preferred_name) parts.push(`display:${c.name}`);
    if (c.username) parts.push(`@${c.username}`);
    parts.push(`telegram_id:${c.telegram_id ?? 'none'}`);
    return parts.join(' — ');
  });
  return {
    success: true,
    output: t(lang).aiTools.meta.contactsList(lines.join('\n')),
    agentHint: recipientIdHint(contacts),
  };
}
handleGetContacts.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleAddContact(
  ctx: AgentContext,
  input: { name: string; username?: string; preferred_name?: string },
): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  if (input.username && !canResolveRecipientUsername(ctx, input.username)) {
    return {
      success: false,
      error: t(ctx.user.language).aiTools.meta.recipientUsernameUnconfirmed,
      agentHint:
        'Ask for the exact @username before saving it. A guessed username cannot create its own verification evidence.',
    };
  }
  let telegramId: number | undefined;
  if (input.username) {
    const user = ctx.userRepo.findByUsername(input.username);
    if (user) telegramId = user.telegram_id;
  }
  const contact = ctx.contactRepo.upsert(
    ctx.user.telegram_id,
    input.name,
    input.username,
    telegramId,
    input.preferred_name,
  );
  const savedName = `"${contact.preferred_name ?? contact.name}"${contact.username ? ` (@${contact.username})` : ''}`;
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactSaved(savedName) };
}

export function handleFindContact(ctx: AgentContext, input: { name: string }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const userId = ctx.user.telegram_id;
  const rawQuery = input.name;
  const ranked = searchContactsRanked(ctx.contactRepo, userId, rawQuery);

  if (ranked.length === 0) return { success: false, error: `No contact named "${rawQuery}" in address book.` };

  const lang = ctx.user.language;
  const matches = ranked.map(({ contact, confidence }) => toContactMatch(contact, confidence));
  const agentHint = recipientIdHint(matches);

  if (ranked.length === 1) {
    const only = ranked[0]!;
    const display = `${formatContactFields(only.contact)} (${confidenceLabel(only.confidence)})`;
    return {
      success: true,
      output: t(lang).aiTools.meta.contactFound(display),
      agentHint,
      data: { matches },
    };
  }

  return {
    success: true,
    output: t(lang).aiTools.meta.contactMatches(matches.map(formatContactMatchLine).join('\n')),
    agentHint,
    data: { matches },
  };
}
handleFindContact.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleUpdateContact(
  ctx: AgentContext,
  input: { search: string; name?: string; preferred_name?: string; username?: string },
): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  const userId = ctx.user.telegram_id;
  const ranked = searchContactsRanked(ctx.contactRepo, userId, input.search);

  if (ranked.length === 0) {
    return { success: false, error: `No contact named "${input.search}" in address book.` };
  }

  const top = ranked[0]!;
  const second = ranked[1];
  const isAmbiguous = second !== undefined && (top.confidence < 1 || top.confidence === second.confidence);
  if (isAmbiguous) {
    const lines = ranked
      .map(({ contact, confidence }) => formatContactMatchLine(toContactMatch(contact, confidence)))
      .join('\n');
    return {
      success: false,
      error: `Multiple contacts match "${input.search}". Ask the user which one to update:\n${lines}`,
    };
  }

  const requestedFields = [input.name, input.preferred_name, input.username].filter((value) => value !== undefined);
  if (requestedFields.length > 0 && requestedFields.some((value) => value.trim().toLowerCase() === 'null')) {
    return {
      success: false,
      error: t(ctx.user.language).aiTools.meta.contactDeleteRequiresTool,
      agentHint: `Use delete_contact with contact_id ${top.contact.id} for the explicit deletion request.`,
    };
  }

  if (input.username && !canResolveRecipientUsername(ctx, input.username)) {
    return { success: false, error: t(ctx.user.language).aiTools.meta.recipientUsernameUnconfirmed };
  }

  const patch: { name?: string; preferred_name?: string; username?: string; telegram_id?: number } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.preferred_name !== undefined) patch.preferred_name = input.preferred_name;
  if (input.username !== undefined) {
    patch.username = input.username.trim().replace(/^@/, '');
    const cachedUser = ctx.userRepo.findByUsername(patch.username);
    if (cachedUser && top.contact.telegram_id !== null && cachedUser.telegram_id !== top.contact.telegram_id) {
      return { success: false, error: t(ctx.user.language).aiTools.meta.recipientIdentityConflict };
    }
    if (cachedUser && top.contact.telegram_id === null) patch.telegram_id = cachedUser.telegram_id;
  }
  if (Object.keys(patch).length === 0) return { success: false, error: 'No fields to update provided.' };
  try {
    ctx.contactRepo.update(top.contact.id, patch);
  } catch (error) {
    // The repository checks identity conflicts before its transactional UPDATE.
    if (error instanceof Error && error.message.startsWith('CONTACT_IDENTITY_CONFLICT:')) {
      return {
        success: false,
        mutationState: 'not_applied',
        error: t(ctx.user.language).aiTools.meta.recipientIdentityConflict,
      };
    }
    throw error;
  }
  const updatedName = patch.name ?? top.contact.name;
  const updated = ctx.contactRepo.findById(userId, top.contact.id);
  const displayName = updated?.preferred_name ?? updated?.name ?? updatedName;
  const updatedLabel = `"${displayName}"${updated?.username ? ` (@${updated.username})` : ''}`;
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactUpdated(updatedLabel) };
}

export function handleDeleteContact(ctx: AgentContext, input: { contact_id: number }): ToolResult {
  if (!ctx.contactRepo) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: t(ctx.user.language).aiTools.meta.contactsPrivateOnly };
  const deleted = ctx.contactRepo.deleteOwned(ctx.user.telegram_id, input.contact_id);
  const tr = t(ctx.user.language).aiTools.meta;
  return {
    success: true,
    output: deleted ? tr.contactDeleted : tr.contactAlreadyAbsent,
    data: { contact_id: input.contact_id, deleted },
  };
}

export async function handleGetUserInfo(ctx: AgentContext, input: { telegram_id: number }): Promise<ToolResult> {
  const tr = t(ctx.user.language).aiTools.meta;
  if (ctx.isGroup || !ctx.contactRepo) return { success: false, error: tr.contactsPrivateOnly };
  const contact = ctx.contactRepo.findByTelegramId(ctx.user.telegram_id, input.telegram_id);
  const explicit = (ctx.messageText.match(/\b\d+\b/g) ?? []).some((value) => value === String(input.telegram_id));
  if (!contact && input.telegram_id !== ctx.user.telegram_id && !explicit)
    return { success: false, error: tr.recipientUnverified };
  const profile = await inspectRecipientProfile(ctx, input.telegram_id);
  if (profile && profile.id !== input.telegram_id) return { success: false, error: tr.recipientIdentityConflict };
  if (profile && !profile.deleted)
    ctx.contactRepo.refreshProfile(ctx.user.telegram_id, input.telegram_id, {
      username: profile.username ?? null,
      firstName: profile.firstName,
    });
  const info: UserInspection = {
    telegram_id: input.telegram_id,
    display_name: profile?.firstName ?? contact?.name ?? null,
    preferred_name: contact?.preferred_name ?? null,
    username: profile ? (profile.username ?? null) : (contact?.username ?? null),
    contact_created_at: contact?.created_at ?? null,
    profile_checked_at: profile?.checkedAt ?? null,
    profile_source: profile ? 'telegram' : 'cached',
    deleted: profile?.deleted ?? null,
  };
  return {
    success: true,
    data: info,
    output: tr.userInfo(JSON.stringify(info, null, 2)),
    agentHint:
      'ID is authoritative. contact_created_at is when this address-book row was created, not the Telegram account registration date. Null means not recorded; never infer account age, revocation time or identity from an old username. Use find_contact for names, get_history/get_action_log for provenance.',
  };
}
handleGetUserInfo.meta = { readonly: false, skipActionLog: false, throttleExempt: true } satisfies ToolHandlerMeta;

// ── Aliases & collective groups (#654 — see ../../contacts/contact-resolver.ts for the shared
// resolution contract these tools expose to the AI) ────────────────────────────────────────

function formatAliasLine(alias: ContactAlias): string {
  return `- ${alias.alias}${alias.is_primary === 1 ? ' (primary)' : ''} [alias_id: ${alias.id}]`;
}

function formatGroupLine(group: ContactGroup): string {
  return `- ${group.alias} [group_id: ${group.id}]`;
}

export function handleAddContactAlias(ctx: AgentContext, input: { contact_id: number; alias: string }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const contact = ctx.contactRepo.findById(userId, input.contact_id);
  if (!contact) return { success: false, error: 'Contact not found in your address book.' };
  try {
    const alias = ctx.contactDirectory.contactAliasRepo.add(userId, contact.id, input.alias, 'manual');
    return { success: true, output: tr.contactAliasAdded(alias.alias, contact.preferred_name ?? contact.name) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTACT_ALIAS_CONFLICT:')) {
      return { success: false, error: tr.contactAliasConflict(input.alias) };
    }
    throw error;
  }
}

export function handleListContactAliases(ctx: AgentContext, input: { contact_id: number }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const contact = ctx.contactRepo.findById(userId, input.contact_id);
  if (!contact) return { success: false, error: 'Contact not found in your address book.' };
  const aliases = ctx.contactDirectory.contactAliasRepo.listForContact(userId, contact.id);
  return {
    success: true,
    output: tr.contactAliasesList(contact.preferred_name ?? contact.name, aliases.map(formatAliasLine).join('\n')),
  };
}
handleListContactAliases.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handlePromoteContactAlias(
  ctx: AgentContext,
  input: { contact_id: number; alias_id: number },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  try {
    ctx.contactDirectory.contactAliasRepo.promote(userId, input.contact_id, input.alias_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTACT_ALIAS_NOT_FOUND:')) {
      return { success: false, error: tr.contactAliasNotFound };
    }
    throw error;
  }
  const primary = ctx.contactDirectory.contactAliasRepo
    .listForContact(userId, input.contact_id)
    .find((alias) => alias.is_primary === 1);
  return { success: true, output: tr.contactAliasPromoted(primary?.alias ?? '') };
}

export function handleDeleteContactAlias(
  ctx: AgentContext,
  input: { contact_id: number; alias_id: number },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const existing = ctx.contactDirectory.contactAliasRepo
    .listForContact(userId, input.contact_id)
    .find((alias) => alias.id === input.alias_id);
  if (!existing) return { success: false, error: tr.contactAliasNotFound };
  try {
    ctx.contactDirectory.contactAliasRepo.delete(userId, input.contact_id, input.alias_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTACT_ALIAS_PRIMARY:')) {
      return { success: false, error: tr.contactAliasPrimaryUndeletable };
    }
    throw error;
  }
  return { success: true, output: tr.contactAliasDeleted(existing.alias) };
}

/** Records a user-confirmed fuzzy match as a learned alias — see ContactResolver.confirmFuzzyMatch. */
export function handleConfirmContactAlias(ctx: AgentContext, input: { contact_id: number; alias: string }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const contact = ctx.contactRepo.findById(userId, input.contact_id);
  if (!contact) return { success: false, error: 'Contact not found in your address book.' };
  ctx.contactDirectory.contactResolver.confirmFuzzyMatch(userId, contact.id, input.alias);
  return { success: true, output: tr.contactAliasAdded(input.alias, contact.preferred_name ?? contact.name) };
}

export function handleCreateContactGroup(ctx: AgentContext, input: { alias: string }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  try {
    const group = ctx.contactDirectory.contactGroupRepo.create(ctx.user.telegram_id, input.alias);
    return { success: true, output: tr.contactGroupCreated(group.alias) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTACT_GROUP_ALIAS_CONFLICT:')) {
      return { success: false, error: tr.contactGroupAliasConflict(input.alias) };
    }
    throw error;
  }
}

export function handleListContactGroups(ctx: AgentContext): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const groups = ctx.contactDirectory.contactGroupRepo.listGroups(ctx.user.telegram_id);
  if (groups.length === 0) return { success: true, output: tr.contactGroupsEmpty };
  return { success: true, output: tr.contactGroupsList(groups.map(formatGroupLine).join('\n')) };
}
handleListContactGroups.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleListContactGroupMembers(ctx: AgentContext, input: { group_id: number }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const group = ctx.contactDirectory.contactGroupRepo.findById(userId, input.group_id);
  if (!group) return { success: false, error: tr.contactGroupNotFound };
  const members = ctx.contactDirectory.contactGroupRepo.listMembers(userId, input.group_id);
  if (members.length === 0) return { success: true, output: tr.contactGroupMembersEmpty(group.alias) };
  const lines = members.map((member) => formatContactMatchLine(toContactMatch(member, 1))).join('\n');
  return { success: true, output: tr.contactGroupMembersList(group.alias, lines) };
}
handleListContactGroupMembers.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

export function handleAddContactGroupMember(
  ctx: AgentContext,
  input: { group_id: number; contact_id: number },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const group = ctx.contactDirectory.contactGroupRepo.findById(userId, input.group_id);
  if (!group) return { success: false, error: tr.contactGroupNotFound };
  try {
    ctx.contactDirectory.contactGroupRepo.addMember(userId, input.group_id, input.contact_id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CONTACT_GROUP_MEMBER_NOT_OWNED:')) {
      return { success: false, error: tr.contactGroupMemberNotOwned };
    }
    throw error;
  }
  const contact = ctx.contactRepo.findById(userId, input.contact_id);
  const label = contact?.preferred_name ?? contact?.name ?? String(input.contact_id);
  return { success: true, output: tr.contactGroupMemberAdded(label, group.alias) };
}

export function handleRemoveContactGroupMember(
  ctx: AgentContext,
  input: { group_id: number; contact_id: number },
): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactRepo || !ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const group = ctx.contactDirectory.contactGroupRepo.findById(userId, input.group_id);
  if (!group) return { success: false, error: tr.contactGroupNotFound };
  const contact = ctx.contactRepo.findById(userId, input.contact_id);
  const removed = ctx.contactDirectory.contactGroupRepo.removeMember(userId, input.group_id, input.contact_id);
  if (!removed) return { success: false, error: 'That contact is not a member of this group.' };
  const label = contact?.preferred_name ?? contact?.name ?? String(input.contact_id);
  return { success: true, output: tr.contactGroupMemberRemoved(label, group.alias) };
}

export function handleDeleteContactGroup(ctx: AgentContext, input: { group_id: number }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const group = ctx.contactDirectory.contactGroupRepo.findById(userId, input.group_id);
  if (!group) return { success: false, error: tr.contactGroupNotFound };
  ctx.contactDirectory.contactGroupRepo.delete(userId, input.group_id);
  return { success: true, output: tr.contactGroupDeleted(group.alias) };
}

/**
 * Single resolution entry point for the AI — same precedence rules the `/contacts` command and
 * (once wired) HcbRuntime652's natural-language commit flow use. See ContactResolver for the
 * exact_unique / exact_ambiguous / exact_group / fuzzy_confirm contract.
 */
export function handleResolveContact(ctx: AgentContext, input: { query: string }): ToolResult {
  const tr = t(ctx.user.language).aiTools.meta;
  if (!ctx.contactDirectory) return { success: false, error: 'Contacts not configured.' };
  if (ctx.isGroup) return { success: false, error: tr.contactsPrivateOnly };
  const userId = ctx.user.telegram_id;
  const result = ctx.contactDirectory.contactResolver.resolve(userId, input.query);

  if (result.kind === 'none') return { success: true, output: tr.resolveContactNone };

  if (result.kind === 'exact_unique') {
    return {
      success: true,
      output: tr.resolveContactUnique(result.contact.preferred_name ?? result.contact.name, result.matchedAlias),
      data: { matches: [toContactMatch(result.contact, 1)] },
    };
  }

  if (result.kind === 'exact_ambiguous') {
    const matches = result.candidates.map((candidate) => toContactMatch(candidate.contact, 1));
    return {
      success: true,
      output: tr.resolveContactAmbiguous(matches.map(formatContactMatchLine).join('\n')),
      agentHint: 'Multiple contacts share this exact name/alias — ask the user to pick one; never guess.',
      data: { matches },
    };
  }

  if (result.kind === 'exact_group') {
    const matches = result.members.map((member) => toContactMatch(member, 1));
    return {
      success: true,
      output: tr.resolveContactGroup(
        result.group.alias,
        matches.map(formatContactMatchLine).join('\n') || '(no members yet)',
      ),
      agentHint: 'Explicit collective alias — invite every listed member, no per-member confirmation needed.',
      data: { matches },
    };
  }

  const matches = result.candidates.map(({ contact, confidence }) => toContactMatch(contact, confidence));
  return {
    success: true,
    output: tr.resolveContactFuzzy(matches.map(formatContactMatchLine).join('\n')),
    agentHint:
      'Fuzzy match only — confirm with the user before proceeding, even with a single candidate. ' +
      'After the user confirms, call manage_contact_directory action=confirm_alias so the same phrasing resolves exactly next time.',
    data: { matches },
  };
}
handleResolveContact.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;

/**
 * AI-facing router for the consolidated `manage_contact_directory` tool (#654) — one action-based
 * schema in place of eleven separate ones, to fit the tool catalog's character/token budget
 * (see test/services/ai/payload-budget.test.ts). Each action delegates to the same granular
 * handler used elsewhere (the `/contacts` command, and this file's own unit tests), so the
 * behavior is identical regardless of caller.
 */
export function handleManageContactDirectory(
  ctx: AgentContext,
  input: {
    action:
      | 'add_alias'
      | 'confirm_alias'
      | 'list_aliases'
      | 'promote_alias'
      | 'delete_alias'
      | 'create_group'
      | 'list_groups'
      | 'list_group_members'
      | 'add_group_member'
      | 'remove_group_member'
      | 'delete_group';
    contact_id?: number;
    alias?: string;
    alias_id?: number;
    group_id?: number;
  },
): ToolResult {
  const missing = (field: string, action: string): ToolResult => ({
    success: false,
    error: `${field} is required for action=${action}.`,
  });

  switch (input.action) {
    case 'add_alias':
      if (input.contact_id === undefined) return missing('contact_id', 'add_alias');
      if (input.alias === undefined) return missing('alias', 'add_alias');
      return handleAddContactAlias(ctx, { contact_id: input.contact_id, alias: input.alias });
    case 'confirm_alias':
      if (input.contact_id === undefined) return missing('contact_id', 'confirm_alias');
      if (input.alias === undefined) return missing('alias', 'confirm_alias');
      return handleConfirmContactAlias(ctx, { contact_id: input.contact_id, alias: input.alias });
    case 'list_aliases':
      if (input.contact_id === undefined) return missing('contact_id', 'list_aliases');
      return handleListContactAliases(ctx, { contact_id: input.contact_id });
    case 'promote_alias':
      if (input.contact_id === undefined) return missing('contact_id', 'promote_alias');
      if (input.alias_id === undefined) return missing('alias_id', 'promote_alias');
      return handlePromoteContactAlias(ctx, { contact_id: input.contact_id, alias_id: input.alias_id });
    case 'delete_alias':
      if (input.contact_id === undefined) return missing('contact_id', 'delete_alias');
      if (input.alias_id === undefined) return missing('alias_id', 'delete_alias');
      return handleDeleteContactAlias(ctx, { contact_id: input.contact_id, alias_id: input.alias_id });
    case 'create_group':
      if (input.alias === undefined) return missing('alias', 'create_group');
      return handleCreateContactGroup(ctx, { alias: input.alias });
    case 'list_groups':
      return handleListContactGroups(ctx);
    case 'list_group_members':
      if (input.group_id === undefined) return missing('group_id', 'list_group_members');
      return handleListContactGroupMembers(ctx, { group_id: input.group_id });
    case 'add_group_member':
      if (input.group_id === undefined) return missing('group_id', 'add_group_member');
      if (input.contact_id === undefined) return missing('contact_id', 'add_group_member');
      return handleAddContactGroupMember(ctx, { group_id: input.group_id, contact_id: input.contact_id });
    case 'remove_group_member':
      if (input.group_id === undefined) return missing('group_id', 'remove_group_member');
      if (input.contact_id === undefined) return missing('contact_id', 'remove_group_member');
      return handleRemoveContactGroupMember(ctx, { group_id: input.group_id, contact_id: input.contact_id });
    case 'delete_group':
      if (input.group_id === undefined) return missing('group_id', 'delete_group');
      return handleDeleteContactGroup(ctx, { group_id: input.group_id });
  }
}
