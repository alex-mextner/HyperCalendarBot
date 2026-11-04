// "Invite me" on an event in someone else's calendar: the requester's own Telegram ID is a verified
// recipient without a @username guess, a numeric mention in the message or a saved contact.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { isKnownRecipient, resolveInvitationRecipient } from '../../../src/services/ai/recipient-identity.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

const REQUESTER_ID = 1001;
const OWNER_ID = 2002;
const INVENTED_ID = 5005005;

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

function context(): AgentContext {
  // Only the fields recipient verification reads; the rest of the context is irrelevant to it.
  return {
    user: { telegram_id: REQUESTER_ID, language: 'ru' },
    messageText: 'Настолки поставь в календарь Ольги и пригласи меня',
    contactRepo: contacts,
    userRepo: { findByTelegramId: () => null, findByUsername: () => null },
  } as unknown as AgentContext;
}

test('the requester own id is a known recipient even when the message names no id', () => {
  expect(isKnownRecipient(context(), REQUESTER_ID)).toBe(true);
  expect(isKnownRecipient(context(), INVENTED_ID)).toBe(false);
  expect(isKnownRecipient(context(), OWNER_ID)).toBe(false);
});

test('inviting oneself resolves to the requester id', async () => {
  expect(await resolveInvitationRecipient(context(), { invitee_id: REQUESTER_ID })).toEqual({
    ok: true,
    id: REQUESTER_ID,
    isGroup: false,
  });
});

test('an address-book row that happens to carry the requester id as its row id does not shadow it', async () => {
  db.prepare('INSERT INTO contacts(id, user_id, name, telegram_id) VALUES (?, ?, ?, ?)').run(
    REQUESTER_ID,
    REQUESTER_ID,
    'Anton',
    3001,
  );
  expect(await resolveInvitationRecipient(context(), { invitee_id: REQUESTER_ID })).toMatchObject({
    ok: true,
    id: REQUESTER_ID,
  });
});

test('an id no tool returned and the message never mentioned stays unverified', async () => {
  expect(await resolveInvitationRecipient(context(), { invitee_id: INVENTED_ID })).toEqual({
    ok: false,
    reason: 'unverified',
  });
});
