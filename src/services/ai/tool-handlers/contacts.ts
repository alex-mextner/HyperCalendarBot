import { t } from '../../../config/constants.ts';
import type { ContactRepository } from '../../../database/repositories/contact.repository.ts';
import type { Contact } from '../../../database/types.ts';
import { canResolveRecipientUsername } from '../recipient-identity.ts';
import { inspectRecipientProfile } from '../recipient-profile.ts';
import type { AgentContext, ContactMatch, ToolHandlerMeta, ToolResult, UserInspection } from '../types.ts';

const MAX_CONTACT_MATCHES = 5;

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
  if (contact.telegram_id) parts.push(`telegram_id: ${contact.telegram_id}`);
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
  if (match.telegram_id) parts.push(`telegram_id: ${match.telegram_id}`);
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
    if (c.telegram_id) parts.push(`telegram_id:${c.telegram_id}`);
    return parts.join(' — ');
  });
  return { success: true, output: t(lang).aiTools.meta.contactsList(lines.join('\n')) };
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

  if (ranked.length === 1) {
    const only = ranked[0]!;
    const display = `${formatContactFields(only.contact)} (${confidenceLabel(only.confidence)})`;
    return {
      success: true,
      output: t(lang).aiTools.meta.contactFound(display),
      data: { matches },
    };
  }

  return {
    success: true,
    output: t(lang).aiTools.meta.contactMatches(matches.map(formatContactMatchLine).join('\n')),
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
