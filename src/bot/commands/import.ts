// src/bot/commands/import.ts
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { parseIcs } from '../../services/ics/parser.ts';
import { t } from '../../config/constants.ts';
import { setSession } from '../types.ts';

export async function handleImport(ctx: any, eventService: EventService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  setSession(user.telegram_id, 'import:waiting');
  await ctx.send(lang === 'ru'
    ? 'Отправьте .ics файл.'
    : 'Send an .ics file.');
}

/**
 * Handle received document for import (called from message handler)
 */
export async function handleImportFile(
  ctx: any,
  eventService: EventService,
  user: User,
  fileContent: string,
): Promise<void> {
  const lang = user.language as 'en' | 'ru';
  const parsed = parseIcs(fileContent);

  if (parsed.length === 0) {
    await ctx.send(lang === 'ru' ? 'Не найдено событий в файле.' : 'No events found in file.');
    return;
  }

  let imported = 0;
  for (const icsEvent of parsed) {
    eventService.createEvent({
      user_id: user.telegram_id,
      title: icsEvent.title,
      start_at: icsEvent.start_at,
      end_at: icsEvent.end_at,
      description: icsEvent.description,
      location: icsEvent.location,
      timezone: user.timezone,
      recurrence_rule: icsEvent.recurrence_rule,
    });
    imported++;
  }

  await ctx.send(lang === 'ru'
    ? `✅ Импортировано ${imported} событий.`
    : `✅ Imported ${imported} events.`);
}
