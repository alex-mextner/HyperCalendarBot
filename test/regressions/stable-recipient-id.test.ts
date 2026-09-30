import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { resolveInvitationRecipient } from '../../src/services/ai/recipient-identity.ts';
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
/** The bot's users table now maps @recycled to a different person than the saved contact,
 *  and holds a corrupt @broken row whose telegram_id is 0. */
function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    messageText: 'Invite Alex',
    contactRepo: contacts,
    userRepo: {
      findByTelegramId: () => null,
      findByUsername: (username: string) =>
        ({
          recycled: { telegram_id: 5000000002, username: 'recycled' },
          broken: { telegram_id: 0, username: 'broken' },
        })[username] ?? null,
    },
    ...overrides,
  } as unknown as AgentContext;
}
test('editing username cannot erase an established Telegram ID', () => {
  const row = contacts.add(10, 'Alex', 'old', 5000000001);
  contacts.update(row.id, { username: 'new' });
  expect(contacts.findById(10, row.id)?.telegram_id).toBe(5000000001);
});
test('numeric invitation to an established contact survives username reassignment', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const result = await resolveInvitationRecipient(context(), { invitee_id: 5000000001 });
  expect(result).toEqual({ ok: true, id: 5000000001, isGroup: false });
  expect(contacts.findByTelegramId(10, 5000000001)?.username).toBe('recycled');
});
test('force alone cannot authorize an unresolved or conflicting identity', async () => {
  const result = await resolveInvitationRecipient(context(), { invitee_id: 5000000002, force: true, event_id: 1 });
  expect(result.ok).toBe(false);
});

test('an inferred saved username alone keeps its established numeric contact identity', async () => {
  contacts.add(10, 'Alex', 'recycled', 5000000001);
  const result = await resolveInvitationRecipient(context(), { invitee_username: 'recycled' });
  expect(result).toMatchObject({ ok: true, id: 5000000001 });
});

test('an explicit @username that the bot has never seen is not_found, never a guessed ID', async () => {
  contacts.add(10, 'Alex', 'old', 5000000001);
  const result = await resolveInvitationRecipient(context({ messageText: 'Invite @stranger' }), {
    invitee_username: 'stranger',
  });
  expect(result).toEqual({ ok: false, reason: 'not_found', username: 'stranger' });
});

test('an explicit @username whose users row has an invalid ID is not_found and never verified', async () => {
  const ctx = context({ messageText: 'Invite @broken' });
  const result = await resolveInvitationRecipient(ctx, { invitee_username: 'broken' });
  expect(result).toEqual({ ok: false, reason: 'not_found', username: 'broken' });
  expect(ctx.verifiedRecipientIds?.has(0) ?? false).toBe(false);
});
