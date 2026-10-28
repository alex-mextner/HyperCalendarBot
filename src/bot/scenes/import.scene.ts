// src/bot/scenes/import.scene.ts
import { Scene } from '@gramio/scenes';
import type { Lang } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { ruPlural } from '../../services/event/formatters.ts';
import { type IcsEvent, parseIcs } from '../../services/ics/parser.ts';
import { botLogger } from '../../utils/logger.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { GramIOFileContext } from '../types.ts';

interface ImportParams {
  groupId?: number;
  groupTimezone?: string;
}

async function readIcsEvents(file: GramIOFileContext, botToken: string): Promise<IcsEvent[]> {
  const { file_path } = await file.getFile();
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file_path}`);
  return parseIcs(await response.text());
}

function importEvents(eventService: EventService, user: User, params: ImportParams, parsed: IcsEvent[]): number {
  const timezone = params.groupTimezone ?? user.timezone;
  const groupFields =
    params.groupId !== undefined
      ? { owner_type: 'group' as const, group_id: params.groupId, created_by: user.telegram_id }
      : {};
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
  }
  return parsed.length;
}

function importedMessage(lang: Lang, imported: number): string {
  return lang === 'ru'
    ? `✅ Импортировано ${imported} ${ruPlural(imported, 'событие', 'события', 'событий')}.`
    : `✅ Imported ${imported} ${imported === 1 ? 'event' : 'events'}.`;
}

export function createImportScene(
  eventService: EventService,
  botToken: string,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
) {
  return (
    new Scene('import')
      .params<ImportParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
      .extend(userComposer)
      .step('message', async (context) => {
        const { lang, dbUser: user } = context;
        if (!user) {
          await context.scene.exit();
          return;
        }

        if (context.scene.step.firstTime) {
          await context.send(lang === 'ru' ? 'Отправьте .ics файл.' : 'Send an .ics file.');
          return;
        }

        // Check for document
        const ctx = context as typeof context & GramIOFileContext;
        if (!ctx.document) {
          await context.send(
            lang === 'ru'
              ? 'Ожидаю .ics файл. Отправьте файл или /cancel.'
              : 'Expecting .ics file. Send a file or /cancel.',
          );
          return;
        }

        try {
          const parsed = await readIcsEvents(ctx, botToken);

          if (parsed.length === 0) {
            await context.send(lang === 'ru' ? 'Не найдено событий в файле.' : 'No events found in file.');
            await context.scene.exit();
            return;
          }

          const imported = importEvents(eventService, user, context.scene.params ?? {}, parsed);

          actionLogRepo?.insert({
            user_id: user.telegram_id,
            chat_id: Number(context.chatId ?? user.telegram_id),
            action_type: 'scene',
            action_name: 'import_events',
            message_id: context.id,
            input_summary: `${imported} events from .ics`,
            result_summary: `imported ${imported}`,
          });

          await context.send(importedMessage(lang, imported));
        } catch (err: unknown) {
          botLogger.warn({ err }, 'import scene: failed to read ICS file');
          await context.send(lang === 'ru' ? 'Не удалось прочитать файл.' : 'Failed to read file.');
        }

        await context.scene.exit();
      })
  );
}
