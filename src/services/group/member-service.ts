import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import { logger } from '../../utils/logger.ts';
import type { ServiceTier } from '../telegram-session/service-tier.ts';

const groupLogger = logger.child({ module: 'group-member-service' });

export class GroupMemberService {
  constructor(
    private groupMemberRepo: GroupMemberRepository,
    private userRepo: UserRepository,
    private serviceTier: ServiceTier,
  ) {}

  /**
   * Members of the chat who have started the bot. The shared service account lists everyone in the
   * chat; without it, or when that listing fails, the members the bot has seen there (group_members).
   */
  async getRegisteredMembers(chatId: number): Promise<number[]> {
    const listed = this.serviceTier.enabled ? await this.serviceTier.getChatMembers(chatId) : null;
    if (this.serviceTier.enabled && listed === null) {
      groupLogger.debug({ chatId }, 'Service account could not list chat members, using tracked members');
    }
    const memberIds = listed ?? this.groupMemberRepo.getActiveMembers(chatId).map((m) => m.user_id);
    return memberIds.filter((id) => this.userRepo.findByTelegramId(id) !== null);
  }
}
