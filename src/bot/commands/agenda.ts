// src/bot/commands/agenda.ts

import { InlineKeyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

const PAGE_SIZE = 10;

interface ChatAccess {
  type: string;
  id: number;
}

export async function handleGroupAgenda(
  ctx: BotCommandContext,
  groupRepo: GroupChatRepository,
  eventRepo: EventRepository,
  page = 0,
): Promise<void> {
  const user = ctx.dbUser;
  const lang = user.language as 'en' | 'ru';
  const chat = ctx.chat as ChatAccess | undefined;

  if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    await ctx.send(lang === 'ru' ? 'Работает только в группах' : 'Works only in groups');
    return;
  }

  const { items, total } = groupRepo.getSharedEventsPaginated(chat.id, page * PAGE_SIZE, PAGE_SIZE);
  if (total === 0) {
    await ctx.send(lang === 'ru' ? 'Нет событий в группе' : 'No events shared with this group');
    return;
  }

  const lines: string[] = [];
  for (const s of items) {
    const event = eventRepo.findById(s.event_id, s.shared_by);
    if (!event) continue;
    lines.push(`📅 ${event.title} — ${event.start_at}`);
  }

  if (lines.length === 0) {
    await ctx.send(lang === 'ru' ? 'Все события удалены' : 'All shared events have been deleted');
    return;
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const header =
    totalPages > 1
      ? lang === 'ru'
        ? `📋 События группы (${page + 1}/${totalPages}):`
        : `📋 Group events (${page + 1}/${totalPages}):`
      : lang === 'ru'
        ? '📋 События группы:'
        : '📋 Group events:';

  const text = `${header}\n\n${lines.join('\n')}`;

  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️', `${CB.GROUP_AGENDA}:${page - 1}`);
  if ((page + 1) * PAGE_SIZE < total) kb.text('➡️', `${CB.GROUP_AGENDA}:${page + 1}`);

  const hasButtons = page > 0 || (page + 1) * PAGE_SIZE < total;
  await ctx.send(text, hasButtons ? { reply_markup: kb } : undefined);
}

export async function handleGroupAgendaCallback(
  ctx: BotCallbackContext,
  groupRepo: GroupChatRepository,
  eventRepo: EventRepository,
  page: number,
): Promise<void> {
  const user = ctx.dbUser;
  const lang = (user?.language ?? 'en') as 'en' | 'ru';
  const chat = ctx.chat as ChatAccess | undefined;

  if (!chat) {
    await ctx.answer();
    return;
  }

  const { items, total } = groupRepo.getSharedEventsPaginated(chat.id, page * PAGE_SIZE, PAGE_SIZE);
  if (total === 0) {
    await ctx.answer();
    await ctx.editText(lang === 'ru' ? 'Нет событий в группе' : 'No events shared with this group');
    return;
  }

  const lines: string[] = [];
  for (const s of items) {
    const event = eventRepo.findById(s.event_id, s.shared_by);
    if (!event) continue;
    lines.push(`📅 ${event.title} — ${event.start_at}`);
  }

  if (lines.length === 0) {
    await ctx.answer();
    await ctx.editText(lang === 'ru' ? 'Все события удалены' : 'All shared events have been deleted');
    return;
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const header =
    totalPages > 1
      ? lang === 'ru'
        ? `📋 События группы (${page + 1}/${totalPages}):`
        : `📋 Group events (${page + 1}/${totalPages}):`
      : lang === 'ru'
        ? '📋 События группы:'
        : '📋 Group events:';

  const text = `${header}\n\n${lines.join('\n')}`;

  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️', `${CB.GROUP_AGENDA}:${page - 1}`);
  if ((page + 1) * PAGE_SIZE < total) kb.text('➡️', `${CB.GROUP_AGENDA}:${page + 1}`);

  const hasButtons = page > 0 || (page + 1) * PAGE_SIZE < total;

  await ctx.answer();
  await ctx.editText(text, hasButtons ? { reply_markup: kb } : undefined);
}
