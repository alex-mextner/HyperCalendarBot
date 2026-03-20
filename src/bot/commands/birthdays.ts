import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { GroupMemberRepository } from '../../database/repositories/group-member.repository.ts';
import type { User } from '../../database/types.ts';
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
import { ruPlural } from '../../services/event/formatters.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export interface FormatBirthdayLineParams {
  title: string;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
  eventDate: Date;
  lang: 'en' | 'ru';
}

function extractName(title: string): string {
  return title.replace(/^(Д\/р |Bday )/, '').trim();
}

function formatDate(date: Date, lang: 'en' | 'ru'): string {
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });
}

export function formatBirthdayLine(params: FormatBirthdayLineParams): string {
  const { title, celebrantId, birthYear, username, eventDate, lang } = params;
  const name = extractName(title);
  const age = birthYear !== null ? eventDate.getFullYear() - birthYear : null;
  const ageSuffix =
    age !== null ? (lang === 'ru' ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}` : ` — turns ${age}`) : '';
  const dateStr = formatDate(eventDate, lang);

  const safeName = escapeHtml(name);
  let nameStr: string;
  if (celebrantId !== null) {
    nameStr = `<a href="tg://user?id=${celebrantId}">${safeName}</a>`;
  } else if (username) {
    nameStr = `${safeName} @${escapeHtml(username)}`;
  } else {
    nameStr = safeName;
  }

  return `🎁 ${nameStr}${ageSuffix} (${dateStr})`;
}

export async function handleBirthdays(
  ctx: BotCommandContext,
  birthdayService: BirthdayService,
  groupChatRepo?: GroupChatRepository,
  groupMemberRepo?: GroupMemberRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  let groupCalendars: { groupId: number; title: string }[] = [];
  if (isGroup(ctx as unknown as Parameters<typeof isGroup>[0])) {
    const groupId = getGroupId(ctx as unknown as Parameters<typeof getGroupId>[0]);
    if (groupId === null) return;
    const group = groupChatRepo?.findByChatId(groupId) ?? null;
    groupCalendars = group ? [{ groupId, title: group.title ?? String(groupId) }] : [];
  } else {
    groupCalendars = (groupMemberRepo?.getGroupsForUser(user.telegram_id) ?? []).map((g) => ({
      groupId: g.chat_id,
      title: g.title ?? String(g.chat_id),
    }));
  }

  const { personal, groups } = birthdayService.getBirthdaysForDisplay(user.telegram_id, groupCalendars);

  if (personal.length === 0 && groups.every((g) => g.items.length === 0)) {
    await ctx.send(lang === 'ru' ? 'Дней рождения пока нет 🎂' : 'No birthdays yet 🎂');
    return;
  }

  const lines: string[] = [lang === 'ru' ? '🎂 <b>Дни рождения</b>' : '🎂 <b>Birthdays</b>', ''];

  if (personal.length > 0) {
    lines.push(lang === 'ru' ? '👤 <b>Личный календарь</b>' : '👤 <b>Personal calendar</b>');
    for (const item of personal) {
      const eventDate = new Date(item.event.start_at);
      lines.push(
        '• ' +
          formatBirthdayLine({
            title: item.event.title,
            celebrantId: item.celebrantId,
            birthYear: item.birthYear,
            username: item.username,
            eventDate,
            lang,
          }),
      );
    }
  }

  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push('');
    lines.push(`👥 <b>${escapeHtml(group.title)}</b>`);
    for (const item of group.items) {
      const eventDate = new Date(item.event.start_at);
      lines.push(
        '• ' +
          formatBirthdayLine({
            title: item.event.title,
            celebrantId: item.celebrantId,
            birthYear: item.birthYear,
            username: item.username,
            eventDate,
            lang,
          }),
      );
    }
  }

  await ctx.send(lines.join('\n'), { parse_mode: 'HTML' });
}
