import { t } from '../../../config/constants.ts';
import type { Contact } from '../../../database/types.ts';
import type { AgentContext, ContactMatch, ToolHandlerMeta, ToolResult } from '../types.ts';

const MAX_CONTACT_MATCHES = 5;

function toContactMatch(contact: Contact, confidence: number): ContactMatch {
  return {
    id: contact.id,
    name: contact.name,
    preferred_name: contact.preferred_name,
    username: contact.username,
    telegram_id: contact.telegram_id,
    confidence,
  };
}

function formatContactFields(contact: Contact): string {
  const parts = [`name: ${contact.name}`];
  if (contact.preferred_name) parts.push(`preferred_name: ${contact.preferred_name}`);
  if (contact.username) parts.push(`username: @${contact.username}`);
  if (contact.telegram_id) parts.push(`telegram_id: ${contact.telegram_id}`);
  return parts.join(', ');
}

function formatContactMatchLine(match: ContactMatch): string {
  const parts = [`name: ${match.name}`];
  if (match.preferred_name) parts.push(`preferred_name: ${match.preferred_name}`);
  if (match.username) parts.push(`username: @${match.username}`);
  if (match.telegram_id) parts.push(`telegram_id: ${match.telegram_id}`);
  const pct = Math.round(match.confidence * 100);
  return `- ${parts.join(', ')} (${pct}%)`;
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
    const parts = [c.preferred_name ?? c.name];
    if (c.preferred_name) parts.push(`display:${c.name}`);
    if (c.username) parts.push(`@${c.username}`);
    if (c.telegram_id) parts.push(`id:${c.telegram_id}`);
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
  const nameQuery = rawQuery.startsWith('@') ? rawQuery.slice(1) : rawQuery;

  const byId = new Map<number, { contact: Contact; confidence: number }>();
  for (const match of ctx.contactRepo.searchByName(userId, nameQuery)) {
    byId.set(match.contact.id, match);
  }

  const usernameMatch = ctx.contactRepo.findByUsername(userId, nameQuery);
  if (usernameMatch) {
    const existing = byId.get(usernameMatch.id);
    if (!existing || existing.confidence < 1) {
      byId.set(usernameMatch.id, { contact: usernameMatch, confidence: 1 });
    }
  }

  const ranked = [...byId.values()]
    .sort((a, b) => b.confidence - a.confidence || a.contact.name.localeCompare(b.contact.name))
    .slice(0, MAX_CONTACT_MATCHES);

  if (ranked.length === 0) return { success: false, error: `No contact named "${rawQuery}" in address book.` };

  const lang = ctx.user.language;
  const matches = ranked.map(({ contact, confidence }) => toContactMatch(contact, confidence));

  if (ranked.length === 1) {
    const only = ranked[0]!;
    return {
      success: true,
      output: t(lang).aiTools.meta.contactFound(formatContactFields(only.contact)),
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
  const query = input.search;
  const contact = query.startsWith('@')
    ? (ctx.contactRepo.findByUsername(userId, query) ?? ctx.contactRepo.findByName(userId, query.slice(1)))
    : (ctx.contactRepo.findByName(userId, query) ?? ctx.contactRepo.findByUsername(userId, query));
  if (!contact) return { success: false, error: `No contact named "${input.search}" in address book.` };
  const patch: { name?: string; preferred_name?: string; username?: string } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.preferred_name !== undefined) patch.preferred_name = input.preferred_name;
  if (input.username !== undefined) patch.username = input.username;
  if (Object.keys(patch).length === 0) return { success: false, error: 'No fields to update provided.' };
  ctx.contactRepo.update(contact.id, patch);
  const updatedName = patch.name ?? contact.name;
  const updated = ctx.contactRepo.findByName(userId, updatedName);
  const displayName = updated?.preferred_name ?? updated?.name ?? updatedName;
  const updatedLabel = `"${displayName}"${updated?.username ? ` (@${updated.username})` : ''}`;
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactUpdated(updatedLabel) };
}
