// src/bot/scenes/add-event.scene.ts

import { Scene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseSimpleDate } from '../../utils/date.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import { getSceneLang, getSceneUser, isCommandEscape } from './helpers.ts';

interface AddEventState {
  title?: string;
  startAt?: string;
}

export function createAddEventScene(eventService: EventService) {
  return (
    new Scene('add_event')
      .state<AddEventState>()
      .on('message', async (context, next) => {
        const text = (context as unknown as { text?: string }).text;
        if (isCommandEscape(text)) {
          await context.scene.exit();
          const lang = getSceneLang(context);
          if (text === '/cancel') {
            await context.send(lang === 'ru' ? 'Отменено.' : 'Cancelled.');
          } else {
            await context.send(
              lang === 'ru' ? 'Сессия прервана. Повторите команду.' : 'Session cancelled. Please resend your command.',
            );
          }
          return;
        }
        return next();
      })
      // Step 0: Title
      .step('message', async (context) => {
        const lang = getSceneLang(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        const text = (context as unknown as { text?: string }).text;
        if (!text?.trim()) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        await context.scene.update({ title: text.trim() });
      })
      // Step 1: Date/Time
      .step('message', async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_time_prompt);
          return;
        }
        const text = (context as unknown as { text?: string }).text;
        if (!text) return;
        const parsed = parseSimpleDate(text, user?.timezone ?? 'UTC');
        if (!parsed) {
          await context.send(
            lang === 'ru'
              ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"'
              : 'Can\'t parse that date. Try: "tomorrow 15:00"',
          );
          return;
        }
        await context.scene.update({ startAt: parsed.toISOString() });
      })
      // Step 2: Duration
      .step('message', async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_duration_prompt);
          return;
        }
        if (!user) return;
        const text = (context as unknown as { text?: string }).text;
        if (!text) return;

        const { title, startAt } = context.scene.state;
        if (!title || !startAt) {
          await context.scene.exit();
          return;
        }

        let endAt: string | undefined;
        if (text.toLowerCase() !== 'skip' && text.toLowerCase() !== 'пропустить') {
          const mins = parseDuration(text);
          if (mins) {
            endAt = addMinutes(new Date(startAt), mins).toISOString();
          }
        }

        const event = eventService.createEvent({
          user_id: user.telegram_id,
          title,
          start_at: startAt,
          end_at: endAt,
          timezone: user.timezone,
        });

        await context.scene.exit();
        const detail = formatEventDetail(event, user.timezone, lang);
        await context.send(`${t(lang).event_created(title)}\n\n${detail}`, {
          parse_mode: 'HTML',
          reply_markup: eventActionsKeyboard(event.id, lang),
        });
      })
  );
}
