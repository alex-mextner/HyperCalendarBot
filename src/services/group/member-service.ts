import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';

export class GroupMemberService {
  constructor(
    private groupMemberRepo: GroupMemberRepository,
    private userRepo: UserRepository,
  ) {}

  /** Members the bot has seen in the chat (group_members) who have also started the bot. */
  async getRegisteredMembers(chatId: number): Promise<number[]> {
    const tracked = this.groupMemberRepo.getActiveMembers(chatId);
    return tracked.map((m) => m.user_id).filter((id) => this.userRepo.findByTelegramId(id) !== null);
  }
}
