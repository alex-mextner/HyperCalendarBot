// src/bot/commands/contacts.ts
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { ContactAliasRepository } from '../../database/repositories/contact-alias.repository.ts';
import type { ContactGroupRepository } from '../../database/repositories/contact-group.repository.ts';
import type { Contact, ContactAlias, ContactGroup } from '../../database/types.ts';
import { isGroup } from '../group-context.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export interface ContactsDeps {
  contactRepo: ContactRepository;
  contactAliasRepo: ContactAliasRepository;
  contactGroupRepo: ContactGroupRepository;
}

const PAGE_SIZE = 8;

function displayName(contact: Contact): string {
  return contact.preferred_name ?? contact.name;
}

// ── List ──

export function buildContactsListKeyboard(contacts: Contact[], lang: Lang, offset: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const page = contacts.slice(offset, offset + PAGE_SIZE);
  for (const contact of page) {
    kb.text(displayName(contact), `${CB.CONTACTS}:view:${contact.id}:${offset}`).row();
  }
  if (offset > 0 || offset + PAGE_SIZE < contacts.length) {
    if (offset > 0) kb.text(t(lang).contacts.btnPrev, `${CB.CONTACTS}:list:${Math.max(0, offset - PAGE_SIZE)}`);
    if (offset + PAGE_SIZE < contacts.length)
      kb.text(t(lang).contacts.btnNext, `${CB.CONTACTS}:list:${offset + PAGE_SIZE}`);
    kb.row();
  }
  kb.text(t(lang).contacts.btnGroups, `${CB.CONTACTS}:groups`);
  return kb;
}

function formatContactsListText(contacts: Contact[], lang: Lang): string {
  if (contacts.length === 0) return t(lang).contacts.empty;
  return t(lang).contacts.listTitle;
}

// ── Contact detail ──

export function buildContactDetailKeyboard(
  contact: Contact,
  aliases: ContactAlias[],
  offset: number,
  lang: Lang,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const alias of aliases) {
    if (alias.is_primary === 1) continue;
    kb.text(
      t(lang).contacts.btnPromote(alias.alias),
      `${CB.CONTACTS}:promote:${contact.id}:${alias.id}:${offset}`,
    ).row();
    kb.text(
      t(lang).contacts.btnDeleteAlias(alias.alias),
      `${CB.CONTACTS}:delalias:${contact.id}:${alias.id}:${offset}`,
    ).row();
  }
  kb.text(t(lang).contacts.btnDeleteContact, `${CB.CONTACTS}:delcontact:${contact.id}:${offset}`).row();
  kb.text(t(lang).contacts.btnBack, `${CB.CONTACTS}:list:${offset}`);
  return kb;
}

export function formatContactDetailText(contact: Contact, aliases: ContactAlias[], lang: Lang): string {
  const tr = t(lang).contacts;
  const lines = [tr.detailHeader(displayName(contact)), '', tr.aliasesLabel];
  for (const alias of aliases) {
    lines.push(`• ${alias.alias}${alias.is_primary === 1 ? tr.primarySuffix : ''}`);
  }
  return lines.join('\n');
}

function buildDeleteContactConfirmKeyboard(contactId: number, offset: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).contacts.btnConfirmDelete, `${CB.CONTACTS}:delcontactok:${contactId}:${offset}`)
    .row()
    .text(t(lang).contacts.btnCancel, `${CB.CONTACTS}:view:${contactId}:${offset}`);
}

// ── Groups ──

export function buildGroupsListKeyboard(groups: ContactGroup[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groups) {
    kb.text(group.alias, `${CB.CONTACTS}:groupview:${group.id}`).row();
  }
  kb.text('⬅️', `${CB.CONTACTS}:list:0`);
  return kb;
}

function formatGroupsListText(groups: ContactGroup[], lang: Lang): string {
  if (groups.length === 0) return t(lang).contacts.groupsEmpty;
  return t(lang).contacts.groupsTitle;
}

export function buildGroupDetailKeyboard(group: ContactGroup, members: Contact[], lang: Lang): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const member of members) {
    kb.text(
      t(lang).contacts.btnRemoveMember(displayName(member)),
      `${CB.CONTACTS}:groupremove:${group.id}:${member.id}`,
    ).row();
  }
  kb.text(t(lang).contacts.btnDeleteGroup, `${CB.CONTACTS}:groupdel:${group.id}`).row();
  kb.text(t(lang).contacts.btnBack, `${CB.CONTACTS}:groups`);
  return kb;
}

export function formatGroupDetailText(group: ContactGroup, members: Contact[], lang: Lang): string {
  const tr = t(lang).contacts;
  const lines = [tr.groupDetailHeader(group.alias), ''];
  if (members.length === 0) {
    lines.push(tr.groupNoMembers);
  } else {
    for (const member of members) lines.push(`• ${displayName(member)}`);
  }
  return lines.join('\n');
}

function buildDeleteGroupConfirmKeyboard(groupId: number, lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang).contacts.btnConfirmDelete, `${CB.CONTACTS}:groupdelok:${groupId}`)
    .row()
    .text(t(lang).contacts.btnCancel, `${CB.CONTACTS}:groupview:${groupId}`);
}

// ── Command entry ──

export async function handleContacts(ctx: BotCommandContext, deps: ContactsDeps): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as Lang;
  if (isGroup(ctx)) {
    await ctx.send(t(lang).contacts.groupNotAllowed);
    return;
  }
  const userId = user.telegram_id;
  const rawArgs = ((ctx.args as string) ?? '').trim();

  if (!rawArgs) {
    const contacts = deps.contactRepo.list(userId);
    await ctx.send(formatContactsListText(contacts, lang), {
      reply_markup: buildContactsListKeyboard(contacts, lang, 0),
    });
    return;
  }

  const [head, ...rest] = rawArgs.split(/\s+/);
  const restText = rest.join(' ');

  if (head === 'add') {
    if (!restText) {
      await ctx.send(t(lang).contacts.addUsage);
      return;
    }
    const contact = deps.contactRepo.upsert(userId, restText);
    await ctx.send(t(lang).contacts.added(displayName(contact)));
    return;
  }

  if (head === 'alias') {
    const [contactIdStr, ...aliasParts] = rest;
    const contactId = Number(contactIdStr);
    const aliasText = aliasParts.join(' ');
    if (!contactIdStr || !Number.isFinite(contactId) || !aliasText) {
      await ctx.send(t(lang).contacts.aliasUsage);
      return;
    }
    const contact = deps.contactRepo.findById(userId, contactId);
    if (!contact) {
      await ctx.send(t(lang).contacts.notFound);
      return;
    }
    try {
      const alias = deps.contactAliasRepo.add(userId, contact.id, aliasText, 'manual');
      await ctx.send(t(lang).contacts.aliasAdded(alias.alias, displayName(contact)));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONTACT_ALIAS_CONFLICT:')) {
        await ctx.send(t(lang).contacts.aliasConflict(aliasText));
        return;
      }
      throw error;
    }
    return;
  }

  if (head === 'groups') {
    const groups = deps.contactGroupRepo.listGroups(userId);
    await ctx.send(formatGroupsListText(groups, lang), { reply_markup: buildGroupsListKeyboard(groups) });
    return;
  }

  if (head === 'group') {
    await handleGroupSubcommand(ctx, deps, userId, lang, rest);
    return;
  }

  await ctx.send(t(lang).contacts.usage);
}

async function handleGroupSubcommand(
  ctx: BotCommandContext,
  deps: ContactsDeps,
  userId: number,
  lang: Lang,
  rest: string[],
): Promise<void> {
  const [sub, ...subRest] = rest;

  if (sub === 'create') {
    const alias = subRest.join(' ');
    if (!alias) {
      await ctx.send(t(lang).contacts.groupUsage);
      return;
    }
    try {
      const group = deps.contactGroupRepo.create(userId, alias);
      await ctx.send(t(lang).contacts.groupCreated(group.alias));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('CONTACT_GROUP_ALIAS_CONFLICT:')) {
        await ctx.send(t(lang).contacts.groupConflict(alias));
        return;
      }
      throw error;
    }
    return;
  }

  if (sub === 'add' || sub === 'remove') {
    const [groupIdStr, contactIdStr] = subRest;
    const groupId = Number(groupIdStr);
    const contactId = Number(contactIdStr);
    if (!groupIdStr || !contactIdStr || !Number.isFinite(groupId) || !Number.isFinite(contactId)) {
      await ctx.send(t(lang).contacts.groupUsage);
      return;
    }
    const group = deps.contactGroupRepo.findById(userId, groupId);
    if (!group) {
      await ctx.send(t(lang).contacts.groupNotFound);
      return;
    }
    const contact = deps.contactRepo.findById(userId, contactId);
    const label = contact ? displayName(contact) : String(contactId);
    if (sub === 'add') {
      try {
        deps.contactGroupRepo.addMember(userId, groupId, contactId);
        await ctx.send(t(lang).contacts.groupMemberAdded(label, group.alias));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('CONTACT_GROUP_MEMBER_NOT_OWNED:')) {
          await ctx.send(t(lang).contacts.groupMemberNotOwned);
          return;
        }
        throw error;
      }
    } else {
      const removed = deps.contactGroupRepo.removeMember(userId, groupId, contactId);
      await ctx.send(
        removed ? t(lang).contacts.groupMemberRemoved(label, group.alias) : t(lang).contacts.groupMemberNotFound,
      );
    }
    return;
  }

  if (sub === 'delete') {
    const groupId = Number(subRest[0]);
    if (!subRest[0] || !Number.isFinite(groupId)) {
      await ctx.send(t(lang).contacts.groupUsage);
      return;
    }
    const group = deps.contactGroupRepo.findById(userId, groupId);
    if (!group) {
      await ctx.send(t(lang).contacts.groupNotFound);
      return;
    }
    deps.contactGroupRepo.delete(userId, groupId);
    await ctx.send(t(lang).contacts.groupDeleted(group.alias));
    return;
  }

  await ctx.send(t(lang).contacts.groupUsage);
}

// ── Callback routing ──

export async function handleContactsCallback(
  ctx: BotCallbackContext,
  payload: string,
  user: { telegram_id: number; language: Lang },
  deps: ContactsDeps,
): Promise<void> {
  const lang = user.language;
  const userId = user.telegram_id;
  const tr = t(lang).contacts;
  const [sub, ...args] = payload.split(':');

  await ctx.answer();

  if (sub === 'list') {
    const offset = Number(args[0] ?? '0') || 0;
    const contacts = deps.contactRepo.list(userId);
    await ctx.editText(formatContactsListText(contacts, lang), {
      reply_markup: buildContactsListKeyboard(contacts, lang, offset),
    });
    return;
  }

  if (sub === 'view') {
    const contactId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const contact = deps.contactRepo.findById(userId, contactId);
    if (!contact) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.contactAliasRepo.listForContact(userId, contact.id);
    await ctx.editText(formatContactDetailText(contact, aliases, lang), {
      reply_markup: buildContactDetailKeyboard(contact, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'promote') {
    const contactId = Number(args[0]);
    const aliasId = Number(args[1]);
    const offset = Number(args[2] ?? '0') || 0;
    try {
      deps.contactAliasRepo.promote(userId, contactId, aliasId);
    } catch {
      // Stale button (alias no longer belongs to this contact): fall through and
      // re-render the unchanged detail view, same as the delalias branch below.
    }
    const contact = deps.contactRepo.findById(userId, contactId);
    if (!contact) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.contactAliasRepo.listForContact(userId, contact.id);
    await ctx.editText(formatContactDetailText(contact, aliases, lang), {
      reply_markup: buildContactDetailKeyboard(contact, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'delalias') {
    const contactId = Number(args[0]);
    const aliasId = Number(args[1]);
    const offset = Number(args[2] ?? '0') || 0;
    try {
      deps.contactAliasRepo.delete(userId, contactId, aliasId);
    } catch {
      // Primary-alias refusal: fall through and re-render the unchanged detail view.
    }
    const contact = deps.contactRepo.findById(userId, contactId);
    if (!contact) {
      await ctx.editText(tr.notFound);
      return;
    }
    const aliases = deps.contactAliasRepo.listForContact(userId, contact.id);
    await ctx.editText(formatContactDetailText(contact, aliases, lang), {
      reply_markup: buildContactDetailKeyboard(contact, aliases, offset, lang),
    });
    return;
  }

  if (sub === 'delcontact') {
    const contactId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const contact = deps.contactRepo.findById(userId, contactId);
    if (!contact) {
      await ctx.editText(tr.notFound);
      return;
    }
    await ctx.editText(tr.confirmDeleteContact(displayName(contact)), {
      reply_markup: buildDeleteContactConfirmKeyboard(contactId, offset, lang),
    });
    return;
  }

  if (sub === 'delcontactok') {
    const contactId = Number(args[0]);
    const offset = Number(args[1] ?? '0') || 0;
    const contact = deps.contactRepo.findById(userId, contactId);
    const deleted = deps.contactRepo.deleteOwned(userId, contactId);
    if (!deleted || !contact) {
      await ctx.editText(tr.notFound);
      return;
    }
    const contacts = deps.contactRepo.list(userId);
    await ctx.editText(`${tr.deletedContact(displayName(contact))}\n\n${formatContactsListText(contacts, lang)}`, {
      reply_markup: buildContactsListKeyboard(contacts, lang, Math.max(0, Math.min(offset, contacts.length - 1))),
    });
    return;
  }

  if (sub === 'groups') {
    const groups = deps.contactGroupRepo.listGroups(userId);
    await ctx.editText(formatGroupsListText(groups, lang), { reply_markup: buildGroupsListKeyboard(groups) });
    return;
  }

  if (sub === 'groupview') {
    const groupId = Number(args[0]);
    const group = deps.contactGroupRepo.findById(userId, groupId);
    if (!group) {
      await ctx.editText(tr.groupNotFound);
      return;
    }
    const members = deps.contactGroupRepo.listMembers(userId, groupId);
    await ctx.editText(formatGroupDetailText(group, members, lang), {
      reply_markup: buildGroupDetailKeyboard(group, members, lang),
    });
    return;
  }

  if (sub === 'groupremove') {
    const groupId = Number(args[0]);
    const contactId = Number(args[1]);
    deps.contactGroupRepo.removeMember(userId, groupId, contactId);
    const group = deps.contactGroupRepo.findById(userId, groupId);
    if (!group) {
      await ctx.editText(tr.groupNotFound);
      return;
    }
    const members = deps.contactGroupRepo.listMembers(userId, groupId);
    await ctx.editText(formatGroupDetailText(group, members, lang), {
      reply_markup: buildGroupDetailKeyboard(group, members, lang),
    });
    return;
  }

  if (sub === 'groupdel') {
    const groupId = Number(args[0]);
    const group = deps.contactGroupRepo.findById(userId, groupId);
    if (!group) {
      await ctx.editText(tr.groupNotFound);
      return;
    }
    await ctx.editText(tr.confirmDeleteGroup(group.alias), {
      reply_markup: buildDeleteGroupConfirmKeyboard(groupId, lang),
    });
    return;
  }

  if (sub === 'groupdelok') {
    const groupId = Number(args[0]);
    const group = deps.contactGroupRepo.findById(userId, groupId);
    const deleted = deps.contactGroupRepo.delete(userId, groupId);
    if (!deleted || !group) {
      await ctx.editText(tr.groupNotFound);
      return;
    }
    const groups = deps.contactGroupRepo.listGroups(userId);
    await ctx.editText(`${tr.groupDeleted(group.alias)}\n\n${formatGroupsListText(groups, lang)}`, {
      reply_markup: buildGroupsListKeyboard(groups),
    });
    return;
  }
}
