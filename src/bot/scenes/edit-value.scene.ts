// src/bot/scenes/edit-value.scene.ts
import { Scene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseSimpleDate } from '../../utils/date.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

interface EditValueParams {
  eventId: number;
  field: string;
}

const EDIT_PROMPTS: Record<string, Record<string, string>> = {
  title: { en: 'Send new title:', ru: 'Отправьте новое название:' },
  time: { en: 'Send new date/time (e.g., "tomorrow 15:00"):', ru: 'Отправьте новую дату/время:' },
  description: {
    en: 'Send new description (or "clear" to remove):',
    ru: 'Отправьте описание (или "clear" для удаления):',
  },
  location: {
    en: 'Send new location (or "clear" to remove):',
    ru: 'Отправьте место (или "clear" для удаления):',
  },
};

export function createEditValueScene(eventService: EventService) {
  return (
    new Scene('edit_value')
      .params<EditValueParams>()
      // onEnter sends prompt — because scene is entered from callback_query
      // but step 0 is "message", so firstTime won't fire on entry
      .onEnter(async (context) => {
        const lang = getSceneLang(context);
        const params = (context as unknown as { scene: { params: EditValueParams } }).scene.params;
        await context.send(EDIT_PROMPTS[params.field]?.[lang] ?? 'Send new value:');
      })
      .on('message', async (context, next) => {
        const text = (context as unknown as { text?: string }).text;
        if (isCommandEscape(text) && !context.scene.step.firstTime) {
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

        const { eventId, field } = context.scene.params;
        const text = (context as unknown as { text?: string }).text;
        if (!text) return;

        const updateData: Record<string, unknown> = {};

        if (field === 'title') {
          updateData.title = text;
        } else if (field === 'time') {
          const parsed = parseSimpleDate(text, user.timezone);
          if (!parsed) {
            await context.send(lang === 'ru' ? 'Не могу разобрать дату.' : "Can't parse that date.");
            return;
          }
          updateData.start_at = parsed.toISOString();
        } else if (field === 'description') {
          updateData.description = text.toLowerCase() === 'clear' ? null : text;
        } else if (field === 'location') {
          updateData.location = text.toLowerCase() === 'clear' ? null : text;
        }

        const updated = eventService.updateEvent(eventId, user.telegram_id, updateData);
        await context.scene.exit();

        if (updated) {
          const detail = formatEventDetail(updated, user.timezone, lang);
          await context.send(`${t(lang).event_updated(updated.title)}\n\n${detail}`, { parse_mode: 'HTML' });
        } else {
          await context.send(t(lang).something_wrong);
        }
      })
  );
}
