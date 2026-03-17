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
      // Only ids 1 and 2 are registered bot users
      const userRepo = makeUserRepo([1, 2]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      // Mock Bun.spawnSync to return successful Pyrogram output
      const spawnSyncMock = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify(pyramMembers)),
        stderr: Buffer.from(''),
        success: true,
      } as ReturnType<typeof Bun.spawnSync>);

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([1, 2]);
        expect(result).not.toContain(3);
      } finally {
        spawnSyncMock.mockRestore();
      }
    });

    test('passes correct chat_id to Pyrogram script', async () => {
      const groupRepo = makeGroupMemberRepo([]);
      const userRepo = makeUserRepo([]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnSyncMock = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 0,
        stdout: Buffer.from(JSON.stringify([])),
        stderr: Buffer.from(''),
        success: true,
      } as ReturnType<typeof Bun.spawnSync>);

      try {
        await service.getRegisteredMembers(CHAT_ID);
        expect(spawnSyncMock).toHaveBeenCalledWith(
          expect.objectContaining({
            cmd: ['venv/bin/python', 'scripts/get-chat-members.py', String(CHAT_ID)],
          }),
        );
      } finally {
        spawnSyncMock.mockRestore();
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
      // Only 10 and 20 are registered
      const userRepo = makeUserRepo([10, 20]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnSyncMock = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from('error'),
        success: false,
      } as ReturnType<typeof Bun.spawnSync>);

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([10, 20]);
        expect(result).not.toContain(30);
      } finally {
        spawnSyncMock.mockRestore();
      }
    });

    test('falls back to group_members table when Pyrogram throws', async () => {
      const groupRepo = makeGroupMemberRepo([{ chat_id: CHAT_ID, user_id: 42, last_seen_at: '2026-01-01T00:00:00Z' }]);
      const userRepo = makeUserRepo([42]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnSyncMock = spyOn(Bun, 'spawnSync').mockImplementation(() => {
        throw new Error('venv not found');
      });

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([42]);
      } finally {
        spawnSyncMock.mockRestore();
      }
    });

    test('filters unregistered users from fallback list', async () => {
      const groupRepo = makeGroupMemberRepo([
        { chat_id: CHAT_ID, user_id: 100, last_seen_at: '2026-01-01T00:00:00Z' },
        { chat_id: CHAT_ID, user_id: 200, last_seen_at: '2026-01-01T00:00:00Z' },
      ]);
      // Neither 100 nor 200 is registered
      const userRepo = makeUserRepo([]);

      const service = new GroupMemberService(groupRepo, userRepo, 'scripts/get-chat-members.py');

      const spawnSyncMock = spyOn(Bun, 'spawnSync').mockReturnValue({
        exitCode: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        success: false,
      } as ReturnType<typeof Bun.spawnSync>);

      try {
        const result = await service.getRegisteredMembers(CHAT_ID);
        expect(result).toEqual([]);
      } finally {
        spawnSyncMock.mockRestore();
      }
    });
  });
});
