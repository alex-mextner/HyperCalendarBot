import { describe, expect, mock, spyOn, test } from 'bun:test';
import type { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { GroupMemberService } from '../../../src/services/group/member-service.ts';

function makeGroupMemberRepo(
  members: { chat_id: number; user_id: number; last_seen_at: string }[],
): GroupMemberRepository {
  return {
    upsert: mock(() => {}),
    getMembers: mock((chatId: number) => members.filter((m) => m.chat_id === chatId)),
  } as unknown as GroupMemberRepository;
}

function makeUserRepo(registeredIds: number[]): UserRepository {
  return {
    findByTelegramId: mock((id: number) => (registeredIds.includes(id) ? { telegram_id: id } : null)),
  } as unknown as UserRepository;
}

function mockSpawnSuccess(stdout: string) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(stdout));
      controller.close();
    },
  });
  return {
    stdout: stream,
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(0),
    pid: 1,
    kill: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

function mockSpawnFailure(exitCode: number) {
  return {
    stdout: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    pid: 1,
    kill: mock(() => {}),
  } as unknown as ReturnType<typeof Bun.spawn>;
}

describe('GroupMemberService', () => {
  const CHAT_ID = -100123;

  describe('getRegisteredMembers — Pyrogram available', () => {
    test('returns registered members from Pyrogram result', async () => {
      const pyramMembers = [
        { id: 1, username: 'alice', first_name: 'Alice' },
        { id: 2, username: 'bob', first_name: 'Bob' },
        { id: 3, username: 'carol', first_name: 'Carol' },
      ];

      const groupRepo = makeGroupMemberRepo([]);
      const userRepo = makeUserRepo([1, 2]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnMock = spyOn(Bun, 'spawn').mockReturnValue(mockSpawnSuccess(JSON.stringify(pyramMembers)));

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([1, 2]);
        expect(result).not.toContain(3);
      } finally {
        spawnMock.mockRestore();
      }
    });

    test('passes correct arguments to Bun.spawn', async () => {
      const groupRepo = makeGroupMemberRepo([]);
      const userRepo = makeUserRepo([]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnMock = spyOn(Bun, 'spawn').mockReturnValue(mockSpawnSuccess(JSON.stringify([])));

      try {
        await service.getRegisteredMembers(CHAT_ID);
        expect(spawnMock).toHaveBeenCalledWith(
          ['venv/bin/python', 'scripts/get-chat-members.py', String(CHAT_ID)],
          expect.objectContaining({ stdout: 'pipe', stderr: 'pipe' }),
        );
      } finally {
        spawnMock.mockRestore();
      }
    });
  });

  describe('getRegisteredMembers — Pyrogram unavailable', () => {
    test('falls back to group_members table when Pyrogram exits non-zero', async () => {
      const groupRepo = makeGroupMemberRepo([
        { chat_id: CHAT_ID, user_id: 10, last_seen_at: '2026-01-01T00:00:00Z' },
        { chat_id: CHAT_ID, user_id: 20, last_seen_at: '2026-01-01T00:00:00Z' },
        { chat_id: CHAT_ID, user_id: 30, last_seen_at: '2026-01-01T00:00:00Z' },
      ]);
      const userRepo = makeUserRepo([10, 20]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnMock = spyOn(Bun, 'spawn').mockReturnValue(mockSpawnFailure(1));

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([10, 20]);
        expect(result).not.toContain(30);
      } finally {
        spawnMock.mockRestore();
      }
    });

    test('falls back to group_members table when Bun.spawn throws', async () => {
      const groupRepo = makeGroupMemberRepo([{ chat_id: CHAT_ID, user_id: 42, last_seen_at: '2026-01-01T00:00:00Z' }]);
      const userRepo = makeUserRepo([42]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnMock = spyOn(Bun, 'spawn').mockImplementation(() => {
        throw new Error('venv not found');
      });

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([42]);
      } finally {
        spawnMock.mockRestore();
      }
    });

    test('filters unregistered users from fallback list', async () => {
      const groupRepo = makeGroupMemberRepo([
        { chat_id: CHAT_ID, user_id: 100, last_seen_at: '2026-01-01T00:00:00Z' },
        { chat_id: CHAT_ID, user_id: 200, last_seen_at: '2026-01-01T00:00:00Z' },
      ]);
      const userRepo = makeUserRepo([]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnMock = spyOn(Bun, 'spawn').mockReturnValue(mockSpawnFailure(1));

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([]);
      } finally {
        spawnMock.mockRestore();
      }
    });
  });
});
