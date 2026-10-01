import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { GroupMemberService } from '../../../src/services/group/member-service.ts';

function makeGroupMemberRepo(
  members: { chat_id: number; user_id: number; last_seen_at: string }[],
): GroupMemberRepository {
  return {
    upsert: mock(() => {}),
    getMembers: mock((chatId: number) => members.filter((m) => m.chat_id === chatId)),
    getActiveMembers: mock((chatId: number) => members.filter((m) => m.chat_id === chatId)),
  } as unknown as GroupMemberRepository;
}

function makeUserRepo(registeredIds: number[]): UserRepository {
  return {
    findByTelegramId: mock((id: number) => (registeredIds.includes(id) ? { telegram_id: id } : null)),
  } as Partial<UserRepository> as UserRepository;
}

describe('GroupMemberService.getRegisteredMembers', () => {
  const CHAT_ID = -100123;
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('no process may be spawned');
  });

  afterEach(() => spawn.mockClear());
  afterAll(() => spawn.mockRestore());

  test('returns the tracked members of the chat who started the bot, without spawning a process', async () => {
    const groupRepo = makeGroupMemberRepo([
      { chat_id: CHAT_ID, user_id: 10, last_seen_at: '2026-01-01T00:00:00Z' },
      { chat_id: CHAT_ID, user_id: 20, last_seen_at: '2026-01-01T00:00:00Z' },
      { chat_id: CHAT_ID, user_id: 30, last_seen_at: '2026-01-01T00:00:00Z' },
      { chat_id: -100999, user_id: 40, last_seen_at: '2026-01-01T00:00:00Z' },
    ]);
    const service = new GroupMemberService(groupRepo, makeUserRepo([10, 20, 40]));

    expect(await service.getRegisteredMembers(CHAT_ID)).toEqual([10, 20]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a chat whose tracked members never started the bot has no registered members', async () => {
    const groupRepo = makeGroupMemberRepo([
      { chat_id: CHAT_ID, user_id: 100, last_seen_at: '2026-01-01T00:00:00Z' },
      { chat_id: CHAT_ID, user_id: 200, last_seen_at: '2026-01-01T00:00:00Z' },
    ]);
    const service = new GroupMemberService(groupRepo, makeUserRepo([]));

    expect(await service.getRegisteredMembers(CHAT_ID)).toEqual([]);
  });
});
