// src/bot/commands/unshare.ts

import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { BotCommandContext } from '../types.ts';

interface ChatAccess {
  type: string;
  id: number;
}

export async function handleUnshare(ctx: BotCommandContext, groupRepo: GroupChatRepository): Promise<void> {
  const user = ctx.dbUser;
  const lang = user.language as 'en' | 'ru';
  const chat = ctx.chat as ChatAccess | undefined;

  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.send(lang === 'ru' ? '❌ Эта команда работает только в groups' : '❌ This command only works in groups');
    return;
  }

  if (!ctx.args || ctx.args.trim() === '') {
    await ctx.send(
      lang === 'ru'
        ? '📤 Использование: <code>/unshare &lt;event_id&gt;</code>'
        : '📤 Usage: <code>/unshare &lt;event_id&gt;</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const eventId = Number(ctx.args.trim());
  if (Number.isNaN(eventId)) {
    await ctx.send(lang === 'ru' ? '❌ Укажите ID события (число)' : '❌ Provide event ID (number)');
    return;
  }

  const removed = groupRepo.unshareEvent(chat.id, eventId, user.telegram_id);
  if (removed) {
    await ctx.send(lang === 'ru' ? '✅ Событие убрано из группы' : '✅ Event removed from group');
  } else {
    await ctx.send(lang === 'ru' ? '❌ Событие не найдено в группе' : '❌ Event not found in this group');
  }
}
