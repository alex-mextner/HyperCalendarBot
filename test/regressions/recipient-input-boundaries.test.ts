import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { hasExplicitUsername } from '../../src/services/ai/recipient-identity.ts';
import { handleUpdateContact } from '../../src/services/ai/tool-handlers/contacts.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

let db: Database | undefined;
afterEach(() => db?.close());
function repo() {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    name TEXT NOT NULL, preferred_name TEXT, username TEXT, telegram_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')));`);
  return new ContactRepository(db);
}

test('email and lookalike domains do not authorize a public Telegram username lookup', () => {
  for (const text of [
    'mail to me@alex.example',
    'https://evil.t.me/alex',
    'https://nottelegram.me/alex',
    '@alex_extra',
  ]) {
    expect(hasExplicitUsername(text, 'alex')).toBe(false);
  }
  for (const text of ['Invite @alex', 'Invite (@alex)', 'https://t.me/alex', 't.me/alex']) {
    expect(hasExplicitUsername(text, 'alex')).toBe(true);
  }
});

test('updating a username cannot rebind a row to another existing contact', () => {
  const contacts = repo();
  const first = contacts.add(10, 'First', 'one', 5000000001);
  contacts.add(10, 'Second', 'two', 5000000002);
  expect(() => contacts.update(first.id, { username: 'two', telegram_id: 5000000002 })).toThrow(
    'CONTACT_IDENTITY_CONFLICT',
  );
  expect(contacts.findById(10, first.id)?.username).toBe('one');
});

test('setting all fields to the string null is not simulated deletion', () => {
  const contacts = repo();
  const contact = contacts.add(10, 'User 5000000002', undefined, 5000000002);
  const ctx = {
    user: { telegram_id: 10, language: 'en' },
    contactRepo: contacts,
    userRepo: { findByUsername: () => null },
  } as unknown as AgentContext;
  const result = handleUpdateContact(ctx, {
    search: '5000000002',
    name: 'null',
    username: 'null',
    preferred_name: 'null',
  });
  expect(result.success).toBe(false);
  expect(result.agentHint).toContain('delete_contact');
  expect(contacts.findById(10, contact.id)?.name).toBe('User 5000000002');
});

test('partial null metadata cannot overwrite a real name', () => {
  const contacts = repo();
  const row = contacts.add(10, 'Real Name', 'real', 5000000001);
  const ctx = {
    user: { telegram_id: 10, language: 'en' },
    contactRepo: contacts,
    userRepo: { findByUsername: () => null },
  } as unknown as AgentContext;
  expect(handleUpdateContact(ctx, { search: '5000000001', name: 'null', username: 'real' }).success).toBe(false);
  expect(contacts.findById(10, row.id)?.name).toBe('Real Name');
});
test('profile refresh clears a legacy at-prefixed reassigned username but never the other ID', () => {
  const contacts = repo();
  const old = contacts.add(10, 'Old', 'reassigned', 5000000001);
  contacts.add(10, 'New', undefined, 5000000002);
  db!.run('UPDATE contacts SET username = ? WHERE id = ?', [' @Reassigned ', old.id]);
  contacts.refreshProfile(10, 5000000002, { username: 'reassigned' });
  expect(contacts.findById(10, old.id)?.username).toBeNull();
  expect(contacts.findById(10, old.id)?.telegram_id).toBe(5000000001);
});
