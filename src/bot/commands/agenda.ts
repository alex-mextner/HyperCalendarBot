// src/bot/commands/agenda.ts

import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { BotCommandContext } from '../types.ts';

interface ChatAccess {
  type: string;
  id: number;
}

export async function handleGroupAgenda(
  ctx: BotCommandContext,
  groupRepo: GroupChatRepository,
  eventRepo: EventRepository,
): Promise<void> {
  const user = ctx.dbUser;
  const lang = user.language as 'en' | 'ru';
  const chat = ctx.chat as ChatAccess | undefined;

  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.send(lang === 'ru' ? 'Работает только в группах' : 'Works only in groups');
    return;
  }

  const shared = groupRepo.getSharedEvents(chat.id);
  if (shared.length === 0) {
    await ctx.send(lang === 'ru' ? 'Нет событий в группе' : 'No events shared with this group');
    return;
  }

  const lines: string[] = [];
  for (const s of shared.slice(0, 10)) {
    const event = eventRepo.findById(s.event_id, s.shared_by);
    if (!event) continue;
    lines.push(`📅 ${event.title} — ${event.start_at}`);
  }

  if (lines.length === 0) {
    await ctx.send(lang === 'ru' ? 'Все события удалены' : 'All shared events have been deleted');
    return;
  }

  await ctx.send(lines.join('\n'));
}
