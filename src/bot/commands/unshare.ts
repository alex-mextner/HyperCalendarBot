// src/bot/commands/unshare.ts

import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { unsharePickerKeyboard } from '../keyboards.ts';
import type { BotCommandContext } from '../types.ts';

interface ChatAccess {
  type: string;
  id: number;
}

export async function handleUnshare(
  ctx: BotCommandContext,
  groupRepo: GroupChatRepository,
  eventService: EventService,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const chat = ctx.chat as ChatAccess | undefined;

  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.send(lang === 'ru' ? '❌ Эта команда работает только в groups' : '❌ This command only works in groups');
    return;
  }

  const shared = groupRepo.getSharedEvents(chat.id).filter((e) => e.shared_by === user.telegram_id);

  if (shared.length === 0) {
    await ctx.send(
      lang === 'ru' ? '📭 У вас нет событий, добавленных в этот чат.' : '📭 You have no events shared in this chat.',
    );
    return;
  }

  const items = shared.map((se) => {
    const event = eventService.getEvent(se.event_id, user.telegram_id);
    return { eventId: se.event_id, title: event?.title ?? `Event #${se.event_id}` };
  });

  await ctx.send(
    lang === 'ru' ? '📤 Выберите событие для удаления из чата:' : '📤 Select an event to remove from this chat:',
    { reply_markup: unsharePickerKeyboard(items, lang) },
  );
}
