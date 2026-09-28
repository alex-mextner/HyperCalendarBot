import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  buildContactDetailKeyboard,
  buildContactsListKeyboard,
  buildGroupDetailKeyboard,
  buildGroupsListKeyboard,
  type ContactsDeps,
  formatContactDetailText,
  formatGroupDetailText,
  handleContacts,
  handleContactsCallback,
} from '../../../src/bot/commands/contacts.ts';
import type { BotCallbackContext, BotCommandContext } from '../../../src/bot/types.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { ContactAliasRepository } from '../../../src/database/repositories/contact-alias.repository.ts';
import { ContactGroupRepository } from '../../../src/database/repositories/contact-group.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { Contact, ContactAlias, ContactGroup } from '../../../src/database/types.ts';

interface InlineButton {
  text: string;
  callback_data?: string;
}

function rows(kb: { toJSON(): { inline_keyboard: InlineButton[][] } }): InlineButton[][] {
  return kb.toJSON().inline_keyboard;
}

const USER_ID = 42;

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeDeps(db: Database): ContactsDeps {
  return {
    contactRepo: new ContactRepository(db),
    contactAliasRepo: new ContactAliasRepository(db),
    contactGroupRepo: new ContactGroupRepository(db),
  };
}

describe('buildContactsListKeyboard', () => {
  function makeContact(id: number, name: string): Contact {
    return { id, user_id: USER_ID, name, username: null, telegram_id: null, preferred_name: null, created_at: '' };
  }

  test('one row per contact, plus a groups button', () => {
    const kb = buildContactsListKeyboard([makeContact(1, 'Anna'), makeContact(2, 'Boris')], 'en', 0);
    const r = rows(kb);
    expect(r[0]?.[0]?.text).toBe('Anna');
    expect(r[1]?.[0]?.text).toBe('Boris');
    expect(r.at(-1)?.[0]?.text).toBe('👥 Groups');
  });

  test('shows next button when more contacts than one page', () => {
    const contacts = Array.from({ length: 9 }, (_, i) => makeContact(i + 1, `C${i + 1}`));
    const kb = buildContactsListKeyboard(contacts, 'en', 0);
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text === '▶️')).toBe(true);
    expect(flat.some((b) => b.text === '◀️')).toBe(false);
  });

  test('shows prev button on a later page', () => {
    const contacts = Array.from({ length: 9 }, (_, i) => makeContact(i + 1, `C${i + 1}`));
    const kb = buildContactsListKeyboard(contacts, 'en', 8);
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text === '◀️')).toBe(true);
  });
});

describe('buildContactDetailKeyboard / formatContactDetailText', () => {
  function makeAlias(id: number, contactId: number, alias: string, isPrimary: number): ContactAlias {
    return {
      id,
      user_id: USER_ID,
      contact_id: contactId,
      alias,
      is_primary: isPrimary,
      source: 'manual',
      created_at: '',
    };
  }

  const contact: Contact = {
    id: 1,
    user_id: USER_ID,
    name: 'Elena',
    username: null,
    telegram_id: null,
    preferred_name: null,
    created_at: '',
  };

  test('primary alias has no promote/delete buttons, non-primary aliases do', () => {
    const aliases = [makeAlias(1, 1, 'Elena', 1), makeAlias(2, 1, 'Ленка', 0)];
    const kb = buildContactDetailKeyboard(contact, aliases, 0, 'en');
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text.includes('Elena'))).toBe(false);
    expect(flat.some((b) => b.text.includes('Ленка'))).toBe(true);
    expect(flat.some((b) => b.text === '🗑 Delete contact')).toBe(true);
    expect(flat.some((b) => b.text === '⬅️ Back')).toBe(true);
  });

  test('detail text marks the primary alias', () => {
    const aliases = [makeAlias(1, 1, 'Elena', 1), makeAlias(2, 1, 'Ленка', 0)];
    const text = formatContactDetailText(contact, aliases, 'en');
    expect(text).toContain('Elena (primary)');
    expect(text).toContain('Ленка');
    expect(text).not.toContain('Ленка (primary)');
  });
});

describe('buildGroupsListKeyboard / buildGroupDetailKeyboard / formatGroupDetailText', () => {
  const group: ContactGroup = { id: 1, user_id: USER_ID, alias: 'грюковы', created_at: '' };

  test('one row per group', () => {
    const kb = buildGroupsListKeyboard([group]);
    expect(rows(kb)[0]?.[0]?.text).toBe('грюковы');
  });

  test('member rows plus delete-group and back buttons', () => {
    const anna: Contact = {
      id: 5,
      user_id: USER_ID,
      name: 'Anna',
      username: null,
      telegram_id: null,
      preferred_name: null,
      created_at: '',
    };
    const kb = buildGroupDetailKeyboard(group, [anna], 'en');
    const flat = rows(kb).flat();
    expect(flat.some((b) => b.text.includes('Anna'))).toBe(true);
    expect(flat.some((b) => b.text === '🗑 Delete group')).toBe(true);
  });

  test('detail text lists members', () => {
    const anna: Contact = {
      id: 5,
      user_id: USER_ID,
      name: 'Anna',
      username: null,
      telegram_id: null,
      preferred_name: null,
      created_at: '',
    };
    expect(formatGroupDetailText(group, [anna], 'en')).toContain('Anna');
    expect(formatGroupDetailText(group, [], 'en')).toContain('No members yet');
  });
});

describe('handleContacts command', () => {
  let db: Database;
  let deps: ContactsDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx(args: string | null, chatType: 'private' | 'group' = 'private'): BotCommandContext {
    return {
      dbUser: { telegram_id: USER_ID, language: 'en' as const },
      args,
      chat: { type: chatType, id: chatType === 'group' ? -100 : USER_ID },
      send: mock(() => Promise.resolve()),
    } as unknown as BotCommandContext;
  }

  test('refuses to run in a group chat', async () => {
    const ctx = makeCtx(null, 'group');
    await handleContacts(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('private'));
  });

  test('no args, empty book shows the empty message', async () => {
    const ctx = makeCtx(null);
    await handleContacts(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('empty'), expect.anything());
  });

  test('add creates a contact', async () => {
    const ctx = makeCtx('add Elena Larichkina');
    await handleContacts(ctx, deps);
    expect(deps.contactRepo.findByName(USER_ID, 'Elena Larichkina')).not.toBeNull();
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('Elena Larichkina'));
  });

  test('alias adds an alias to an existing contact', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Elena');
    const ctx = makeCtx(`alias ${contact.id} Ленка`);
    await handleContacts(ctx, deps);
    expect(deps.contactAliasRepo.listForContact(USER_ID, contact.id).map((a) => a.alias)).toContain('Ленка');
  });

  test('alias reports a conflict without throwing', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Elena');
    deps.contactAliasRepo.add(USER_ID, contact.id, 'Ленка', 'manual');
    const ctx = makeCtx(`alias ${contact.id} Ленка`);
    await handleContacts(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('already an alias'));
  });

  test('group create then group add wires a member', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Anna');
    await handleContacts(makeCtx('group create грюковы'), deps);
    const group = deps.contactGroupRepo.findByAlias(USER_ID, 'грюковы')!;
    await handleContacts(makeCtx(`group add ${group.id} ${contact.id}`), deps);
    expect(deps.contactGroupRepo.listMembers(USER_ID, group.id).map((c) => c.id)).toEqual([contact.id]);
  });

  test('group create rejects a duplicate alias', async () => {
    await handleContacts(makeCtx('group create грюковы'), deps);
    const ctx = makeCtx('group create грюковы');
    await handleContacts(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('already used'));
  });

  test('group rename changes the alias', async () => {
    await handleContacts(makeCtx('group create грюковы'), deps);
    const group = deps.contactGroupRepo.findByAlias(USER_ID, 'грюковы')!;
    const ctx = makeCtx(`group rename ${group.id} семья Грюковых`);
    await handleContacts(ctx, deps);
    expect(deps.contactGroupRepo.findById(USER_ID, group.id)?.alias).toBe('семья Грюковых');
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('renamed'));
  });

  // GH-654 review finding: renaming a group onto an existing person's alias must be refused,
  // the same as creating a group with that alias would be.
  test('group rename rejects landing on an existing person alias', async () => {
    await handleContacts(makeCtx('group create грюковы'), deps);
    const group = deps.contactGroupRepo.findByAlias(USER_ID, 'грюковы')!;
    deps.contactRepo.add(USER_ID, 'Lena');
    const ctx = makeCtx(`group rename ${group.id} Lena`);
    await handleContacts(ctx, deps);
    expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining('already used'));
    expect(deps.contactGroupRepo.findById(USER_ID, group.id)?.alias).toBe('грюковы');
  });

  test('group delete removes the group without deleting members', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Anna');
    await handleContacts(makeCtx('group create грюковы'), deps);
    const group = deps.contactGroupRepo.findByAlias(USER_ID, 'грюковы')!;
    deps.contactGroupRepo.addMember(USER_ID, group.id, contact.id);
    await handleContacts(makeCtx(`group delete ${group.id}`), deps);
    expect(deps.contactGroupRepo.listGroups(USER_ID)).toEqual([]);
    expect(deps.contactRepo.findById(USER_ID, contact.id)).not.toBeNull();
  });
});

describe('handleContactsCallback', () => {
  let db: Database;
  let deps: ContactsDeps;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
  });

  function makeCtx(): BotCallbackContext {
    return {
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    } as unknown as BotCallbackContext;
  }

  const user = { telegram_id: USER_ID, language: 'en' as const };

  test('view shows the contact detail with its aliases', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Elena');
    const ctx = makeCtx();
    await handleContactsCallback(ctx, `view:${contact.id}:0`, user, deps);
    expect(ctx.editText).toHaveBeenCalledWith(expect.stringContaining('Elena'), expect.anything());
  });

  test('promote makes a non-primary alias primary', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Elena');
    const alias = deps.contactAliasRepo.add(USER_ID, contact.id, 'Ленка', 'manual');
    const ctx = makeCtx();
    await handleContactsCallback(ctx, `promote:${contact.id}:${alias.id}:0`, user, deps);
    expect(deps.contactRepo.findById(USER_ID, contact.id)?.name).toBe('Ленка');
  });

  test('delcontact then delcontactok deletes the contact', async () => {
    const contact = deps.contactRepo.add(USER_ID, 'Elena');
    const askCtx = makeCtx();
    await handleContactsCallback(askCtx, `delcontact:${contact.id}:0`, user, deps);
    expect(askCtx.editText).toHaveBeenCalledWith(expect.stringContaining('Delete'), expect.anything());

    const confirmCtx = makeCtx();
    await handleContactsCallback(confirmCtx, `delcontactok:${contact.id}:0`, user, deps);
    expect(deps.contactRepo.findById(USER_ID, contact.id)).toBeNull();
  });

  test('groupview then groupremove removes a member without deleting the contact', async () => {
    const group = deps.contactGroupRepo.create(USER_ID, 'грюковы');
    const anna = deps.contactRepo.add(USER_ID, 'Anna');
    deps.contactGroupRepo.addMember(USER_ID, group.id, anna.id);

    const viewCtx = makeCtx();
    await handleContactsCallback(viewCtx, `groupview:${group.id}`, user, deps);
    expect(viewCtx.editText).toHaveBeenCalledWith(expect.stringContaining('Anna'), expect.anything());

    const removeCtx = makeCtx();
    await handleContactsCallback(removeCtx, `groupremove:${group.id}:${anna.id}`, user, deps);
    expect(deps.contactGroupRepo.listMembers(USER_ID, group.id)).toEqual([]);
    expect(deps.contactRepo.findById(USER_ID, anna.id)).not.toBeNull();
  });

  test('groupdel then groupdelok deletes the group', async () => {
    const group = deps.contactGroupRepo.create(USER_ID, 'грюковы');
    const askCtx = makeCtx();
    await handleContactsCallback(askCtx, `groupdel:${group.id}`, user, deps);
    expect(askCtx.editText).toHaveBeenCalledWith(expect.stringContaining('Delete group'), expect.anything());

    const confirmCtx = makeCtx();
    await handleContactsCallback(confirmCtx, `groupdelok:${group.id}`, user, deps);
    expect(deps.contactGroupRepo.listGroups(USER_ID)).toEqual([]);
  });
});

// GH-654 confirmed blocker (parent's exact-head review of PR693): handleContacts rejects group
// chats, but handleContactsCallback had no matching guard, and CB.CONTACTS dispatch calls it
// unconditionally. A contacts callback delivered in a group must never read or render the
// actor's private address book into that group message — owner-scoped repository ids are not
// enough, because the rendered message itself leaks into the group.
describe('handleContactsCallback refuses group chat scope', () => {
  let db: Database;
  let deps: ContactsDeps;
  let contact: Contact;
  let alias: ContactAlias;
  let group: ContactGroup;

  beforeEach(() => {
    db = createTestDb();
    new UserRepository(db).create({ telegram_id: USER_ID, timezone: 'UTC' });
    deps = makeDeps(db);
    contact = deps.contactRepo.add(USER_ID, 'Elena');
    alias = deps.contactAliasRepo.add(USER_ID, contact.id, 'Ленка', 'manual');
    group = deps.contactGroupRepo.create(USER_ID, 'грюковы');
  });

  const user = { telegram_id: USER_ID, language: 'en' as const };

  function makeGroupCtx(): BotCallbackContext {
    return {
      chat: { type: 'group' as const, id: -100 },
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    } as unknown as BotCallbackContext;
  }

  test('list callback in a group never renders the address book', async () => {
    const ctx = makeGroupCtx();
    await handleContactsCallback(ctx, 'list:0', user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(ctx.answer).toHaveBeenCalledWith(expect.objectContaining({ show_alert: true }));
  });

  test('view callback in a group never edits the group message with contact detail', async () => {
    const ctx = makeGroupCtx();
    await handleContactsCallback(ctx, `view:${contact.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('promote callback in a group is rejected without changing the primary alias', async () => {
    const ctx = makeGroupCtx();
    await handleContactsCallback(ctx, `promote:${contact.id}:${alias.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.contactRepo.findById(USER_ID, contact.id)?.name).toBe('Elena');
  });

  test('delete callback in a group is rejected without removing the contact', async () => {
    const ctx = makeGroupCtx();
    await handleContactsCallback(ctx, `delcontactok:${contact.id}:0`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
    expect(deps.contactRepo.findById(USER_ID, contact.id)).not.toBeNull();
  });

  test('group callback in a group chat is rejected without editing the group message', async () => {
    const ctx = makeGroupCtx();
    await handleContactsCallback(ctx, `groupview:${group.id}`, user, deps);
    expect(ctx.editText).not.toHaveBeenCalled();
  });
});
