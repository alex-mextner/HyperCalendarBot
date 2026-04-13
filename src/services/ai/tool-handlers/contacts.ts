import { t } from '../../../config/constants.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';

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
  const query = input.name;
  const userId = ctx.user.telegram_id;
  const contact = query.startsWith('@')
    ? (ctx.contactRepo.findByUsername(userId, query) ?? ctx.contactRepo.findByName(userId, query.slice(1)))
    : (ctx.contactRepo.findByName(userId, query) ?? ctx.contactRepo.findByUsername(userId, query));
  if (!contact) return { success: false, error: `No contact named "${input.name}" in address book.` };
  const parts = [`name: ${contact.name}`];
  if (contact.preferred_name) parts.push(`preferred_name: ${contact.preferred_name}`);
  if (contact.username) parts.push(`username: @${contact.username}`);
  if (contact.telegram_id) parts.push(`telegram_id: ${contact.telegram_id}`);
  const data = parts.join(', ');
  return { success: true, output: t(ctx.user.language).aiTools.meta.contactFound(data) };
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
