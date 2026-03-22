// src/bot/scenes/import.scene.ts
import { Scene } from '@gramio/scenes';
import type { EventService } from '../../services/event/event-service.ts';
import { ruPlural } from '../../services/event/formatters.ts';
import { parseIcs } from '../../services/ics/parser.ts';
import type { GramIOMessageExtras } from '../types.ts';
import { getSceneLang, getSceneUser } from './helpers.ts';

interface ImportParams {
  groupId?: number;
  groupTimezone?: string;
}

export function createImportScene(eventService: EventService, botToken: string) {
  return new Scene('import').params<ImportParams>().step('message', async (context) => {
    const lang = getSceneLang(context);
    const user = getSceneUser(context);
    if (!user) {
      await context.scene.exit();
      return;
    }

    if (context.scene.step.firstTime) {
      await context.send(lang === 'ru' ? 'Отправьте .ics файл.' : 'Send an .ics file.');
      return;
    }

    // Check for document
    const ctx = context as typeof context & GramIOMessageExtras;
    if (!ctx.document) {
      await context.send(
        lang === 'ru'
          ? 'Ожидаю .ics файл. Отправьте файл или /cancel.'
          : 'Expecting .ics file. Send a file or /cancel.',
      );
      return;
    }

    try {
      const file = await ctx.getFile();
      const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
      const content = await response.text();
      const parsed = parseIcs(content);

      if (parsed.length === 0) {
        await context.send(lang === 'ru' ? 'Не найдено событий в файле.' : 'No events found in file.');
        await context.scene.exit();
        return;
      }

      const params = context.scene.params ?? {};
      const { groupId, groupTimezone } = params;
      const timezone = groupTimezone ?? user.timezone;
      const groupFields =
        groupId !== undefined ? { owner_type: 'group' as const, group_id: groupId, created_by: user.telegram_id } : {};

      let imported = 0;
      for (const icsEvent of parsed) {
        eventService.createEvent({
          user_id: user.telegram_id,
          title: icsEvent.title,
          start_at: icsEvent.start_at,
          end_at: icsEvent.end_at,
          description: icsEvent.description,
          location: icsEvent.location,
          timezone,
          recurrence_rule: icsEvent.recurrence_rule,
          ...groupFields,
        });
        imported++;
      }

      await context.send(
        lang === 'ru'
          ? `✅ Импортировано ${imported} ${ruPlural(imported, 'событие', 'события', 'событий')}.`
          : `✅ Imported ${imported} ${imported === 1 ? 'event' : 'events'}.`,
      );
    } catch {
      await context.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
    }

    await context.scene.exit();
  });
}
