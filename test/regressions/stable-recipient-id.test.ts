import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { resolveInvitationRecipient } from '../../src/services/ai/recipient-identity.ts';
import { inspectRecipientProfile } from '../../src/services/ai/recipient-profile.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

let db: Database;
let contacts: ContactRepository;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    "CREATE TABLE contacts(id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, username TEXT, telegram_id INTEGER, preferred_name TEXT, created_at TEXT DEFAULT (datetime('now')))",
  );
  contacts = new ContactRepository(db);
});
afterEach(() => db.close());
function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    messageText: 'Invite Alex',
    contactRepo: contacts,
    userRepo: { findByTelegramId: () => null, findByUsername: () => null },
    ...overrides,
  } as unknown as AgentContext;
}
test('editing username cannot erase an established Telegram ID', () => {
  const row = contacts.add(10, 'Alex', 'old', 5000000001);
  contacts.update(row.id, { username: 'new' });
  expect(contacts.findById(10, row.id)?.telegram_id).toBe(5000000001);
});
test('verified profile refresh accepts missing username without changing the ID or alias', () => {
  const row = contacts.add(10, 'Alex', 'old', 5000000001, 'Sasha');
  contacts.refreshProfile(10, 5000000001, { username: null, firstName: 'Alexander' });
  expect(contacts.findById(10, row.id)).toMatchObject({
    telegram_id: 5000000001,
    username: null,
    preferred_name: 'Sasha',
  });
});
test('numeric invitation to an established contact survives username reassignment', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const ctx = context({ lookupTelegramUser: async () => ({ id: 5000000001, username: 'new', firstName: 'Alex' }) });
  await inspectRecipientProfile(ctx, 5000000001); // Explicit prior inspection, not hidden work during delivery.
  const result = await resolveInvitationRecipient(ctx, { invitee_id: 5000000001 });
  expect(result).toMatchObject({ ok: true, id: 5000000001, username: 'new' });
  expect(contacts.findByTelegramId(10, 5000000001)?.username).toBe('new');
});
test('live ID lookup returning another ID is rejected without changing contact data', async () => {
  contacts.add(10, 'Alex', 'old', 5000000001);
  const ctx = context({ lookupTelegramUser: async () => ({ id: 5000000002, username: 'other' }) });
  await inspectRecipientProfile(ctx, 5000000001);
  const result = await resolveInvitationRecipient(ctx, { invitee_id: 5000000001 });
  expect(result.ok).toBe(false);
  expect(contacts.findByTelegramId(10, 5000000001)?.username).toBe('old');
});
test('force alone cannot authorize an unresolved or conflicting identity', async () => {
  const result = await resolveInvitationRecipient(context(), { invitee_id: 5000000002, force: true, event_id: 1 });
  expect(result.ok).toBe(false);
});

test('a stale username cache cannot override a current explicit Telegram lookup', async () => {
  const c = context({
    messageText: 'Invite @reassigned',
    resolveUsername: async () => ({ id: 5000000002, username: 'reassigned', firstName: 'Current' }),
  });
  c.userRepo.findByUsername = () =>
    ({ telegram_id: 5000000001, username: 'reassigned' }) as ReturnType<typeof c.userRepo.findByTelegramId>;
  const result = await resolveInvitationRecipient(c, { invitee_username: 'reassigned' });
  expect(result).toMatchObject({ ok: true, id: 5000000002 });
});

test('an inferred saved username alone keeps its established numeric contact identity', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const ctx = context({
    resolveUsername: async () => ({ id: 5000000002, username: 'recycled' }),
    lookupTelegramUser: async () => ({ id: 5000000001, username: 'current' }),
  });
  await inspectRecipientProfile(ctx, 5000000001);
  const result = await resolveInvitationRecipient(ctx, { invitee_username: 'recycled' });
  expect(result).toMatchObject({ ok: true, id: 5000000001, username: 'current' });
});
