// src/bot/scenes/add-event.scene.ts

import { Scene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { CB, t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseSimpleDate } from '../../utils/date.ts';
import {
  eventActionsKeyboard,
  recurrenceEndKeyboard,
  recurrenceKeyboard,
  sceneHelpKeyboard,
  skipKeyboard,
} from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { AddEventState } from './types.ts';

/** Step indices that accept only button presses. Text input on these triggers AI (scene-pause Trigger 2). */
export const CALLBACK_ONLY_STEP_INDICES = new Set([3, 4]); // recurrence (3), recurrence-end (4)

export function applyDefaultDuration(startAt: string, defaultMinutes: number): string {
  return addMinutes(new Date(startAt), defaultMinutes).toISOString();
}

export function createAddEventScene(eventService: EventService, userComposer: UserResolverComposer) {
  return (
    new Scene('add_event')
      .state<AddEventState>()
      .extend(userComposer)
      // Step 0: Title (text only)
      .step('message', async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        const text = context.text;
        if (!text?.trim()) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        await context.scene.update({ title: text.trim() });
      })
      // Step 1: Date/Time (text only)
      .step('message', async (context) => {
        const { lang, dbUser: user } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_time_prompt);
          return;
        }
        const text = context.text;
        if (!text) return;
        const parsed = parseSimpleDate(text, user?.timezone ?? 'UTC');
        if (!parsed) {
          await context.send(
            lang === 'ru'
              ? 'Не могу разобрать дату. Попробуйте: "завтра 15:00"'
              : 'Can\'t parse that date. Try: "tomorrow 15:00"',
            { reply_markup: sceneHelpKeyboard(lang) },
          );
          return;
        }
        await context.scene.update({ startAt: parsed.toISOString() });
      })
      // Step 2: Duration (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_duration_prompt, {
            reply_markup: skipKeyboard(lang, 2),
          });
          return;
        }

        // Handle skip callback
        if (context.is('callback_query')) {
          const data = context.data;
          if (data === `${CB.ADD_SKIP}:2`) {
            await context.answer();
            const defaultMins = context.dbUser?.default_event_duration_minutes ?? 60;
            const { startAt } = context.scene.state;
            if (startAt) {
              await context.scene.update({ endAt: applyDefaultDuration(startAt, defaultMins) });
            } else {
              await context.scene.update({});
            }
            return;
          }
          await context.answer();
          return;
        }

        // Handle text input
        const text = context.text;
        if (!text) return;

        const { startAt } = context.scene.state;
        if (!startAt) {
          await context.scene.exit();
          return;
        }

        const mins = parseDuration(text);
        if (!mins) {
          await context.send(
            lang === 'ru'
              ? 'Не понял. Примеры: 1ч, 30м, 1ч30м, 1 час 30 минут.'
              : "Can't parse. Examples: 1h, 30m, 1h30m, 1 hour 30 min.",
            { reply_markup: sceneHelpKeyboard(lang) },
          );
          return;
        }
        await context.scene.update({ endAt: addMinutes(new Date(startAt), mins).toISOString() });
      })
      // Step 3: Recurrence (button selection only — text input is handled by AI via Trigger 2)
      .step('callback_query', async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_prompt, {
            reply_markup: recurrenceKeyboard(lang),
          });
          return;
        }

        const data = context.data;
        if (!data) return;
        const value = data.replace(`${CB.ADD_RECURRENCE}:`, '');
        await context.answer();

        if (value === 'none') {
          await context.scene.update({ recurrenceRule: null });
          // Skip recurrence-end step (step 4) → jump to description (step 5)
          await context.scene.step.go(5, true);
          return;
        }

        if (value === 'custom') {
          await context.send(t(lang).recurrence_custom_prompt, { reply_markup: sceneHelpKeyboard(lang) });
          return;
        }

        // DAILY, WEEKLY, MONTHLY, YEARLY
        await context.scene.update({ recurrenceRule: `FREQ=${value}` });
      })
      // Step 4: Recurrence End (button selection only — text input is handled by AI via Trigger 2)
      .step('callback_query', async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_end_prompt, {
            reply_markup: recurrenceEndKeyboard(lang),
          });
          return;
        }

        const data = context.data;
        if (!data) return;
        const value = data.replace(`${CB.ADD_REC_END}:`, '');
        await context.answer();

        if (value === 'forever') {
          await context.scene.update({});
          return;
        }

        if (value === 'until') {
          await context.scene.update({ recEndMode: 'until' }, { step: undefined });
          await context.send(t(lang).recurrence_until_prompt, { reply_markup: sceneHelpKeyboard(lang) });
          return;
        }

        if (value === 'count') {
          await context.scene.update({ recEndMode: 'count' }, { step: undefined });
          await context.send(t(lang).recurrence_count_prompt, { reply_markup: sceneHelpKeyboard(lang) });
          return;
        }
      })
      // Step 5: Description (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_description_prompt, {
            reply_markup: skipKeyboard(lang, 5),
          });
          return;
        }

        if (context.is('callback_query')) {
          const data = context.data;
          if (data === `${CB.ADD_SKIP}:5`) {
            await context.answer();
            await context.scene.update({});
            return;
          }
          await context.answer();
          return;
        }

        const text = context.text;
        if (!text) return;
        await context.scene.update({ description: text });
      })
      // Step 6: Location → create event (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const { lang, dbUser: user } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_location_prompt, {
            reply_markup: skipKeyboard(lang, 6),
          });
          return;
        }
        if (!user) return;

        let location: string | undefined;

        if (context.is('callback_query')) {
          const data = context.data;
          if (data === `${CB.ADD_SKIP}:6`) {
            await context.answer();
            location = undefined;
          } else {
            await context.answer();
            return;
          }
        } else {
          const text = context.text;
          if (!text) return;
          location = text;
        }

        const { title, startAt, endAt, description, recurrenceRule } = context.scene.state;
        if (!title || !startAt) {
          await context.scene.exit();
          return;
        }

        const event = eventService.createEvent({
          user_id: user.telegram_id,
          title,
          start_at: startAt,
          end_at: endAt,
          timezone: user.timezone,
          description,
          location,
          recurrence_rule: recurrenceRule ?? undefined,
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
