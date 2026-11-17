import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { cachedRecipientProfile } from '../../src/services/ai/recipient-profile.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';
import {
  createServiceTier,
  type ScriptResult,
  SERVICE_SCRIPTS,
  type ServiceScript,
  type ServiceScriptRunner,
  type TelegramProfile,
} from '../../src/services/telegram-session/service-tier.ts';

const OWNER = 5_900_000_001;
const RECIPIENT = 5_900_000_002;
const SERVICE_ACCOUNT = 5_900_000_003;
const USERNAME = 'synthetic_cached_recipient';
const oldProfile = { id: RECIPIENT, username: USERNAME, firstName: 'Synthetic Recipient' };
const deletedProfile = { id: RECIPIENT, deleted: true };
type Sender = NonNullable<AgentContext['sender']>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function ok(value: unknown): ScriptResult {
  return { stdout: JSON.stringify(value), stderr: '', exitCode: 0 };
}

async function fixture(db: Database) {
  const resolutionProfiles = new Map<string, TelegramProfile>([[USERNAME, oldProfile]]);
  const calls: { script: ServiceScript; args: readonly string[] }[] = [];
  const lookupStarted = deferred<void>();
  const lookupReply = deferred<ScriptResult>();
  const run: ServiceScriptRunner = async (script, args) => {
    calls.push({ script, args });
    if (script === SERVICE_SCRIPTS.probe) return ok({ ok: true, user_id: SERVICE_ACCOUNT });
    if (script === SERVICE_SCRIPTS.resolveUsername) {
      const profile = resolutionProfiles.get(args[0] ?? '');
      if (!profile) throw new Error(`Unexpected synthetic username: ${args[0]}`);
      return ok(profile);
    }
    if (script === SERVICE_SCRIPTS.lookupUser) {
      lookupStarted.resolve();
      return lookupReply.promise;
    }
    throw new Error(`Unexpected synthetic service script: ${script}`);
  };
  const tier = await createServiceTier(
    { MTPROTO_API_ID: 123, MTPROTO_API_HASH: 'synthetic', MTPROTO_SERVICE_USER_ID: SERVICE_ACCOUNT },
    { dataDirectory: '/synthetic', sessionExists: () => true, run },
  );
  if (!tier.enabled) throw new Error(`Synthetic service tier disabled: ${tier.reason}`);

  // The service cache predates this AgentContext. Its second answer must be a real cache hit,
  // not a stub pretending that a new live username lookup is stale.
  expect(await tier.resolveUsername(USERNAME)).toEqual(oldProfile);

  const users = new UserRepository(db);
  users.create({ telegram_id: OWNER, timezone: 'UTC', language: 'en' });
  const events = new EventRepository(db);
  const invitations = new InvitationRepository(db);
  const contacts = new ContactRepository(db);
  const botSend = mock<NonNullable<Sender['sendInvitation']>>(async () => ({ message_id: 9001 }));
  const personalSend = mock<NonNullable<Sender['sendAsConnectedUser']>>(async () => true);
  const sender: Sender = {
    sendMessage: mock<NonNullable<Sender['sendMessage']>>(async () => ({ message_id: 9002 })),
    editMessageText: mock<NonNullable<Sender['editMessageText']>>(async () => {}),
    sendInvitation: botSend,
    sendAsConnectedUser: personalSend,
  };
  const ctx = {
    user: users.findByTelegramId(OWNER)!,
    chatId: OWNER,
    messageText: `Inspect ${RECIPIENT}, find @${USERNAME}, and invite this person.`,
    isGroup: false,
    userRepo: users,
    contactRepo: contacts,
    eventService: new EventService({ eventRepo: events }),
    sharing: {
      invitationRepo: invitations,
      invitationService: new InvitationService(invitations, events, new SharingSettingsRepository(db)),
    },
    resolveUsername: tier.resolveUsername,
    lookupTelegramUser: tier.lookupUser,
    sender,
  } as unknown as AgentContext;
  const event = ctx.eventService.createEvent({
    user_id: OWNER,
    title: 'Synthetic cached-profile refusal',
    start_at: new Date(Date.now() + 86_400_000).toISOString(),
    timezone: 'UTC',
  });
  return {
    ctx,
    event,
    calls,
    lookupStarted,
    lookupReply,
    invitations,
    contacts,
    botSend,
    personalSend,
    resolutionProfiles,
  };
}

const recipients = [
  { label: 'numeric ID', input: { invitee_id: RECIPIENT } },
  { label: 'username', input: { invitee_username: USERNAME } },
] as const;

describe('service username cache cannot supersede a newer recipient inspection', () => {
  let db: Database;
  beforeEach(() => {
    _resetToolThrottleForTest();
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
  });
  afterEach(() => {
    mock.restore();
    _resetToolThrottleForTest();
    db.close();
  });

  for (const pending of [false, true]) {
    for (const recipient of recipients) {
      test(`${pending ? 'pending' : 'completed'} deleted inspection blocks a cached ${recipient.label} invitation`, async () => {
        const f = await fixture(db);
        const inspection = executeTool(f.ctx, 'get_user_info', { telegram_id: RECIPIENT });
        await f.lookupStarted.promise;
        try {
          if (!pending) {
            f.lookupReply.resolve(ok(deletedProfile));
            expect((await inspection).data).toMatchObject({ telegram_id: RECIPIENT, deleted: true });
          }
          // A refusal here is also valid: find_user must not promote a cached service answer
          // into evidence newer than this completed or already-in-flight inspection.
          await executeTool(f.ctx, 'find_user', { username: `@${USERNAME}` });
        } finally {
          f.lookupReply.resolve(ok(deletedProfile));
          await inspection;
        }
        expect((await inspection).data).toMatchObject({ telegram_id: RECIPIENT, deleted: true });

        const result = await executeTool(f.ctx, 'send_invitation', {
          event_id: f.event.id,
          ...recipient.input,
        });
        // Both username calls (find_user and the optional username send) use the service's
        // ten-minute cache. No second resolve script may manufacture fresh evidence.
        expect(f.calls.filter(({ script }) => script === SERVICE_SCRIPTS.resolveUsername)).toEqual([
          { script: SERVICE_SCRIPTS.resolveUsername, args: [USERNAME] },
        ]);
        expect(f.calls.filter(({ script }) => script === SERVICE_SCRIPTS.lookupUser)).toEqual([
          { script: SERVICE_SCRIPTS.lookupUser, args: [String(RECIPIENT)] },
        ]);
        expect({
          success: result.success,
          invitationCount: f.invitations.getByEvent(f.event.id).length,
          contactCount: f.contacts.list(OWNER).length,
          botSends: f.botSend.mock.calls.length,
          personalSends: f.personalSend.mock.calls.length,
          deleted: cachedRecipientProfile(f.ctx, RECIPIENT)?.deleted,
        }).toEqual({
          success: false,
          invitationCount: 0,
          contactCount: 0,
          botSends: 0,
          personalSends: 0,
          deleted: true,
        });
      });
    }
  }

  for (const recipient of recipients) {
    test(`deleted inspection survives profile-cache eviction before a cached ${recipient.label} invitation`, async () => {
      // Keep the inspection inside its 30-second lifetime while exercising the independent
      // 32-entry resolved-profile cache through real, successful username tool calls.
      spyOn(Date, 'now').mockReturnValue(Date.now());
      const f = await fixture(db);
      f.lookupReply.resolve(ok(deletedProfile));
      expect((await executeTool(f.ctx, 'get_user_info', { telegram_id: RECIPIENT })).data).toMatchObject({
        telegram_id: RECIPIENT,
        deleted: true,
      });
      const fillers = Array.from({ length: 32 }, (_, index) => ({
        id: 5_900_100_000 + index,
        username: `synthetic_cache_filler_${index}`,
        firstName: `Synthetic Filler ${index}`,
      }));
      f.ctx.messageText += ` Also find ${fillers.map(({ username }) => `@${username}`).join(' ')}.`;
      for (const profile of fillers) {
        f.resolutionProfiles.set(profile.username, profile);
        expect((await executeTool(f.ctx, 'find_user', { username: profile.username })).success).toBe(true);
      }
      // The inspection cache still knows A is deleted even after the resolved-profile entry
      // has been evicted. A cache hit for A must not hide that independent evidence.
      expect(cachedRecipientProfile(f.ctx, RECIPIENT)?.deleted).toBe(true);
      const found =
        'invitee_id' in recipient.input ? await executeTool(f.ctx, 'find_user', { username: USERNAME }) : undefined;
      const result = await executeTool(f.ctx, 'send_invitation', {
        event_id: f.event.id,
        ...recipient.input,
      });
      expect(f.calls.filter(({ script }) => script === SERVICE_SCRIPTS.resolveUsername)).toHaveLength(33);
      expect(
        f.calls.filter(({ script, args }) => script === SERVICE_SCRIPTS.resolveUsername && args[0] === USERNAME),
      ).toEqual([{ script: SERVICE_SCRIPTS.resolveUsername, args: [USERNAME] }]);
      expect({
        foundSuccess: found?.success,
        success: result.success,
        invitationCount: f.invitations.getByEvent(f.event.id).length,
        contactCount: f.contacts.list(OWNER).length,
        botSends: f.botSend.mock.calls.length,
        personalSends: f.personalSend.mock.calls.length,
        deleted: cachedRecipientProfile(f.ctx, RECIPIENT)?.deleted,
      }).toEqual({
        foundSuccess: 'invitee_id' in recipient.input ? false : undefined,
        success: false,
        invitationCount: 0,
        contactCount: 0,
        botSends: 0,
        personalSends: 0,
        deleted: true,
      });
    });
  }

  const currentProfiles: { label: string; profile: TelegramProfile; savedUsername: string | null }[] = [
    {
      label: 'changed username',
      profile: {
        id: RECIPIENT,
        firstName: 'Current Synthetic Recipient',
        username: 'synthetic_current_recipient',
        deleted: false,
      },
      savedUsername: 'synthetic_current_recipient',
    },
    {
      label: 'removed username',
      profile: { id: RECIPIENT, firstName: 'Current Synthetic Recipient', deleted: false },
      savedUsername: null,
    },
  ];
  for (const current of currentProfiles) {
    for (const recipient of recipients) {
      test(`a ${recipient.label} invitation uses inspected metadata with a ${current.label}`, async () => {
        const f = await fixture(db);
        f.lookupReply.resolve(ok(current.profile));
        const inspected = await executeTool(f.ctx, 'get_user_info', { telegram_id: RECIPIENT });
        expect(inspected.data).toMatchObject({
          telegram_id: RECIPIENT,
          display_name: current.profile.firstName,
          username: current.savedUsername,
          deleted: false,
        });
        const result = await executeTool(f.ctx, 'send_invitation', {
          event_id: f.event.id,
          ...recipient.input,
        });
        expect(result.effect).toEqual({ kind: 'invitation', delivery: 'delivered' });
        expect(f.invitations.getByEvent(f.event.id)).toHaveLength(1);
        expect(f.invitations.getByEvent(f.event.id)[0]?.invitee_id).toBe(RECIPIENT);
        expect(f.botSend).toHaveBeenCalledTimes(1);
        expect(cachedRecipientProfile(f.ctx, RECIPIENT)?.username).toBe(current.profile.username);
        expect(f.calls.filter(({ script }) => script === SERVICE_SCRIPTS.resolveUsername)).toEqual([
          { script: SERVICE_SCRIPTS.resolveUsername, args: [USERNAME] },
        ]);
        expect(f.contacts.findByTelegramId(OWNER, RECIPIENT)).toMatchObject({
          telegram_id: RECIPIENT,
          name: current.profile.firstName,
          username: current.savedUsername,
        });
      });
    }
  }
});
