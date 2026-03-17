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
      const result = Bun.spawnSync({
        cmd: ['venv/bin/python', this.pyBridgePath, String(chatId)],
        timeout: 10_000,
      });
      if (result.exitCode === 0) {
        const members = JSON.parse(result.stdout.toString()) as { id: number }[];
        const memberIds = members.map((m) => m.id);
        return memberIds.filter((id) => this.userRepo.findByTelegramId(id) !== null);
      }
      groupLogger.warn({ chatId, exitCode: result.exitCode }, 'Pyrogram fetch failed, using fallback');
    } catch (error) {
      groupLogger.warn({ chatId, error: String(error) }, 'Pyrogram unavailable, using fallback');
    }

    // Fallback: use tracked members from group_members table
    const tracked = this.groupMemberRepo.getMembers(chatId);
    return tracked.map((m) => m.user_id).filter((id) => this.userRepo.findByTelegramId(id) !== null);
  }
}
