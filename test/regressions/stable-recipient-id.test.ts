import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
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
  const usersDb = new Database(':memory:');
  runMigrations(usersDb, migrations);
  const userRepo = new UserRepository(usersDb);
  userRepo.create({ telegram_id: 5000000001, timezone: 'UTC', language: 'en', username: 'reassigned' });
  const c = context({
    messageText: 'Invite @reassigned',
    userRepo,
    resolveUsername: async () => ({ id: 5000000002, username: 'reassigned', firstName: 'Current' }),
  });
  const result = await resolveInvitationRecipient(c, { invitee_username: 'reassigned' });
  expect(result).toMatchObject({ ok: true, id: 5000000002 });
  usersDb.close();
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

// Without the service tier (no ctx.resolveUsername / ctx.lookupTelegramUser) only the users table
// answers, and an unknown @username is "could not look up", never "does not exist" (#753).
function usersWith(rows: { telegram_id: number; username: string }[]): UserRepository {
  const usersDb = new Database(':memory:');
  runMigrations(usersDb, migrations);
  const userRepo = new UserRepository(usersDb);
  for (const row of rows) userRepo.create({ ...row, timezone: 'UTC', language: 'en' });
  return userRepo;
}

test('tier off: a numeric invitation keeps the established ID and the saved username', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const result = await resolveInvitationRecipient(context(), { invitee_id: 5000000001 });
  expect(result).toEqual({ ok: true, id: 5000000001, isGroup: false });
  expect(contacts.findByTelegramId(10, 5000000001)?.username).toBe('recycled');
});

test('tier off: an inferred saved username keeps its numeric contact identity', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const userRepo = usersWith([{ telegram_id: 5000000002, username: 'recycled' }]);
  const result = await resolveInvitationRecipient(context({ userRepo }), { invitee_username: 'recycled' });
  expect(result).toMatchObject({ ok: true, id: 5000000001 });
});

test('tier off: an explicit @username the bot has never seen is unavailable, never a guessed ID', async () => {
  contacts.add(10, 'Alex', 'old', 5000000001);
  const result = await resolveInvitationRecipient(context({ messageText: 'Invite @stranger' }), {
    invitee_username: 'stranger',
  });
  expect(result).toEqual({ ok: false, reason: 'unavailable', username: 'stranger' });
});

test('tier off: a users row with an invalid ID is unavailable and never verified', async () => {
  const ctx = context({ messageText: 'Invite @broken', userRepo: usersWith([{ telegram_id: 0, username: 'broken' }]) });
  const result = await resolveInvitationRecipient(ctx, { invitee_username: 'broken' });
  expect(result).toEqual({ ok: false, reason: 'unavailable', username: 'broken' });
  expect(ctx.verifiedRecipientIds?.has(0) ?? false).toBe(false);
});

test('tier on: a username Telegram does not know is not_found', async () => {
  const ctx = context({ messageText: 'Invite @stranger', resolveUsername: async () => null });
  const result = await resolveInvitationRecipient(ctx, { invitee_username: 'stranger' });
  expect(result).toEqual({ ok: false, reason: 'not_found', username: 'stranger' });
});
