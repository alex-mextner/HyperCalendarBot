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

function groupWelcome(lang: 'en' | 'ru'): string {
  if (lang === 'ru') {
    return (
      '👋 Привет! Я бот-календарь.\n\n' +
      'Групповые возможности:\n' +
      '• 📅 /agenda — события, которыми участники поделились с группой\n' +
      '• 📤 /share — поделиться своим событием с группой\n' +
      '• ❌ /unshare — убрать расшаренное событие\n' +
      '• 🤖 Упомяни меня или напиши /cal + текст для управления через ИИ\n\n' +
      'В личке: личные события, напоминания, /week, /month, импорт и многое другое.\n\n' +
      '💡 Сделай меня администратором — и я смогу закреплять актуальный календарь, давать ссылку на группу в уведомлениях участникам и автоматически обновлять групповой календарь когда участники приходят и уходят.'
    );
  }
  return (
    "👋 Hi! I'm your calendar assistant.\n\n" +
    'Group features:\n' +
    '• 📅 /agenda — events shared with this group\n' +
    '• 📤 /share — share your event with the group\n' +
    '• ❌ /unshare — remove your shared event\n' +
    '• 🤖 Mention me or use /cal + text to manage the calendar with AI\n\n' +
    'In DM: personal events, reminders, /week, /month, import and more.\n\n' +
    '💡 Make me an admin — and I can pin the calendar automatically, include a group link in notifications to members, and keep the group calendar up to date when people join or leave.'
  );
}

export function createChatMemberHandler(
  groupRepo: GroupChatRepository,
  sendMessage: (chatId: number, text: string) => Promise<void>,
  getUserLanguage: (userId: number) => 'en' | 'ru',
  exportInviteLink: (chatId: number) => Promise<string | null>,
) {
  return async (ctx: ChatMemberContext): Promise<void> => {
    const update = ctx.myChatMember;
    if (!update) return;

    const { chat, from, new_chat_member: newMember, old_chat_member: oldMember } = update;

    if (chat.type !== 'group' && chat.type !== 'supergroup') return;

    if (ACTIVE_STATUSES.has(newMember.status)) {
      groupRepo.upsertGroup({
        chat_id: chat.id,
        title: chat.title,
        added_by: from.id,
      });
      cmdLogger.info({ chatId: chat.id, title: chat.title }, 'Bot added to group');

      // Send welcome only on fresh join (not role change within active statuses)
      if (INACTIVE_STATUSES.has(oldMember.status) || oldMember.status === 'restricted') {
        const lang = getUserLanguage(from.id);
        await sendMessage(chat.id, groupWelcome(lang));
      }

      // Store invite link when bot becomes admin
      if (newMember.status === 'administrator' && oldMember.status !== 'administrator') {
        exportInviteLink(chat.id)
          .then((link) => {
            if (link) groupRepo.setInviteLink(chat.id, link);
          })
          .catch((err: unknown) => {
            cmdLogger.error({ chatId: chat.id, err: err }, 'Failed to export invite link');
          });
      }
    } else if (INACTIVE_STATUSES.has(newMember.status)) {
      groupRepo.deactivate(chat.id);
      cmdLogger.info({ chatId: chat.id }, 'Bot removed from group');
    }
  };
}
