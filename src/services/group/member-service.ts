import { z } from 'zod';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { logger } from '../../utils/logger.ts';

const groupLogger = logger.child({ module: 'group-member-service' });

export class GroupMemberService {
  constructor(
    private groupMemberRepo: GroupMemberRepository,
    private userRepo: UserRepository,
    private pyBridgePath = 'scripts/get-chat-members.py',
  ) {}

  async getRegisteredMembers(chatId: number): Promise<number[]> {
    // Try Pyrogram first
    try {
      const proc = Bun.spawn(['venv/bin/python', this.pyBridgePath, String(chatId)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const stdout = await new Response(proc.stdout).text();
        const members = z.array(z.object({ id: z.number() })).parse(JSON.parse(stdout));
        const memberIds = members.map((m) => m.id);
        return memberIds.filter((id) => this.userRepo.findByTelegramId(id) !== null);
      }
    } catch (error) {
      groupLogger.debug({ chatId, err: error }, 'Pyrogram unavailable, using fallback');
    }

    // Fallback: use tracked members from group_members table
    const tracked = this.groupMemberRepo.getMembers(chatId);
    return tracked.map((m) => m.user_id).filter((id) => this.userRepo.findByTelegramId(id) !== null);
  }
}
