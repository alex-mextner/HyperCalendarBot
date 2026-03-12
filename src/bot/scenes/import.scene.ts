// src/bot/scenes/import.scene.ts
import { Scene } from '@gramio/scenes';
import type { EventService } from '../../services/event/event-service.ts';
import { parseIcs } from '../../services/ics/parser.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

export function createImportScene(eventService: EventService, botToken: string) {
  return new Scene('import')
    .on('message', async (context, next) => {
      const text = (context as unknown as { text?: string }).text;
      if (isCommandEscape(text)) {
        await context.scene.exit();
        const lang = getSceneLang(context);
        await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
        return;
      }
      return next();
    })
    .step('message', async (context) => {
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
      const ctx = context as unknown as {
        document?: { file_id: string; file_name?: string };
        getFile(): Promise<{ file_path: string }>;
        text?: string;
      };

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

        await context.send(
          lang === 'ru' ? `\u2705 Импортировано ${imported} событий.` : `\u2705 Imported ${imported} events.`,
        );
      } catch {
        await context.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
      }

      await context.scene.exit();
    });
}
