import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { GroupMemberService } from '../../../src/services/group/member-service.ts';
import { disabledServiceTier, enabledServiceTier } from '../../helpers/service-tier.ts';

const CHAT_ID = -100123;
const OTHER_CHAT_ID = -100999;

let groupMembers: GroupMemberRepository;
let users: UserRepository;

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  groupMembers = new GroupMemberRepository(db);
  users = new UserRepository(db);
});

function registerUsers(...ids: number[]): void {
  for (const id of ids) users.create({ telegram_id: id, first_name: `User ${id}`, language: 'en', timezone: 'UTC' });
}

function track(chatId: number, ...ids: number[]): void {
  for (const id of ids) groupMembers.upsert(chatId, id);
}

describe('GroupMemberService.getRegisteredMembers', () => {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('no process may be spawned');
  });
  afterEach(() => spawn.mockClear());
  afterAll(() => spawn.mockRestore());

  test('with the service tier on, lists the members Telegram reports who started the bot', async () => {
    registerUsers(10, 30, 40);
    track(CHAT_ID, 40);
    const getChatMembers = mock(async (_chatId: number): Promise<number[] | null> => [10, 20, 30]);
    const service = new GroupMemberService(groupMembers, users, enabledServiceTier({ getChatMembers }));

    expect((await service.getRegisteredMembers(CHAT_ID)).sort()).toEqual([10, 30]);
    expect(getChatMembers.mock.calls).toEqual([[CHAT_ID]]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('with the service tier on but the listing failing, falls back to the tracked members', async () => {
    registerUsers(10, 20);
    track(CHAT_ID, 10, 20, 30);
    const service = new GroupMemberService(
      groupMembers,
      users,
      enabledServiceTier({ getChatMembers: async () => null }),
    );

    expect((await service.getRegisteredMembers(CHAT_ID)).sort()).toEqual([10, 20]);
  });

  test('with the service tier off, lists the tracked members of the chat who started the bot', async () => {
    registerUsers(10, 20, 40);
    track(CHAT_ID, 10, 20, 30);
    track(OTHER_CHAT_ID, 40);
    const service = new GroupMemberService(groupMembers, users, disabledServiceTier);

    expect((await service.getRegisteredMembers(CHAT_ID)).sort()).toEqual([10, 20]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a tracked member who left the chat is not listed', async () => {
    registerUsers(10, 20);
    track(CHAT_ID, 10, 20);
    groupMembers.leave(CHAT_ID, 20);
    const service = new GroupMemberService(groupMembers, users, disabledServiceTier);

    expect(await service.getRegisteredMembers(CHAT_ID)).toEqual([10]);
  });
});
