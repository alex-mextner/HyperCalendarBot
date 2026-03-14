import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import { cmdLogger } from '../../utils/logger.ts';

interface ChatMemberContext {
  myChatMember?: {
    chat: { id: number; type: string; title?: string };
    from: { id: number };
    new_chat_member: { status: string };
    old_chat_member: { status: string };
  };
}

const ACTIVE_STATUSES = new Set(['member', 'administrator', 'creator']);
const INACTIVE_STATUSES = new Set(['left', 'kicked']);

export function createChatMemberHandler(groupRepo: GroupChatRepository) {
  return async (ctx: ChatMemberContext): Promise<void> => {
    const update = ctx.myChatMember;
    if (!update) return;

    const { chat, from, new_chat_member: newMember } = update;

    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    if (ACTIVE_STATUSES.has(newMember.status)) {
      groupRepo.upsertGroup({
        chat_id: chat.id,
        title: chat.title,
        added_by: from.id,
      });
      cmdLogger.info({ chatId: chat.id, title: chat.title }, 'Bot added to group');
    } else if (INACTIVE_STATUSES.has(newMember.status)) {
      groupRepo.deactivate(chat.id);
      cmdLogger.info({ chatId: chat.id }, 'Bot removed from group');
    }
  };
}
