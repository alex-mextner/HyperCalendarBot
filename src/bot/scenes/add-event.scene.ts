// src/bot/scenes/add-event.scene.ts

import { Scene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { CB, t } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseRecurrence, parseSimpleDate } from '../../utils/date.ts';
import { eventActionsKeyboard, recurrenceEndKeyboard, recurrenceKeyboard, skipKeyboard } from '../keyboards.ts';
import { getSceneLang, getSceneUser } from './helpers.ts';

interface AddEventState {
  title?: string;
  startAt?: string;
  endAt?: string;
  recurrenceRule?: string | null;
  recEndMode?: 'until' | 'count';
  description?: string;
  location?: string;
}

function getCallbackData(context: unknown): string | undefined {
  return (context as { data?: string }).data;
}

function getMessageText(context: unknown): string | undefined {
  return (context as { text?: string }).text;
}

function isCallbackQuery(context: unknown): boolean {
  return typeof getCallbackData(context) === 'string';
}

async function answerCallback(context: unknown): Promise<void> {
  const ctx = context as { answer?: (opts?: Record<string, unknown>) => Promise<unknown> };
  await ctx.answer?.();
}

export function createAddEventScene(eventService: EventService) {
  return (
    new Scene('add_event')
      .state<AddEventState>()
      // Step 0: Title (text only)
      .step('message', async (context) => {
        const lang = getSceneLang(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        const text = getMessageText(context);
        if (!text?.trim()) {
          await context.send(t(lang).add_title_prompt);
          return;
        }
        await context.scene.update({ title: text.trim() });
      })
      // Step 1: Date/Time (text only)
      .step('message', async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_time_prompt);
          return;
        }
        const text = getMessageText(context);
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
      // Step 2: Duration (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const lang = getSceneLang(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_duration_prompt, {
            reply_markup: skipKeyboard(lang, 2),
          });
          return;
        }

        // Handle skip callback
        if (isCallbackQuery(context)) {
          const data = getCallbackData(context)!;
          if (data === `${CB.ADD_SKIP}:2`) {
            await answerCallback(context);
            await context.scene.update({});
            return;
          }
          await answerCallback(context);
          return;
        }

        // Handle text input
        const text = getMessageText(context);
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
          );
          return;
        }
        await context.scene.update({ endAt: addMinutes(new Date(startAt), mins).toISOString() });
      })
      // Step 3: Recurrence (keyboard + custom text)
      .step(['message', 'callback_query'], async (context) => {
        const lang = getSceneLang(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_prompt, {
            reply_markup: recurrenceKeyboard(lang),
          });
          return;
        }

        if (isCallbackQuery(context)) {
          const data = getCallbackData(context)!;
          const value = data.replace(`${CB.ADD_RECURRENCE}:`, '');
          await answerCallback(context);

          if (value === 'none') {
            await context.scene.update({ recurrenceRule: null });
            // Skip recurrence-end step (step 4) → jump to description (step 5)
            await context.scene.step.go(5, true);
            return;
          }

          if (value === 'custom') {
            await context.send(t(lang).recurrence_custom_prompt);
            return;
          }

          // DAILY, WEEKLY, MONTHLY, YEARLY
          await context.scene.update({ recurrenceRule: `FREQ=${value}` });
          return;
        }

        // Text input for custom recurrence
        const text = getMessageText(context);
        if (!text) return;

        const parsed = parseRecurrence(text);
        if (!parsed) {
          await context.send(t(lang).recurrence_custom_prompt);
          return;
        }
        const rule = parsed.interval > 1 ? `FREQ=${parsed.freq};INTERVAL=${parsed.interval}` : `FREQ=${parsed.freq}`;
        await context.scene.update({ recurrenceRule: rule });
      })
      // Step 4: Recurrence End (conditional — skipped if no recurrence)
      .step(['message', 'callback_query'], async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_end_prompt, {
            reply_markup: recurrenceEndKeyboard(lang),
          });
          return;
        }

        if (isCallbackQuery(context)) {
          const data = getCallbackData(context)!;
          const value = data.replace(`${CB.ADD_REC_END}:`, '');
          await answerCallback(context);

          if (value === 'forever') {
            // No change to RRULE
            await context.scene.update({});
            return;
          }

          if (value === 'until') {
            await context.scene.update({ recEndMode: 'until' }, { step: undefined });
            await context.send(t(lang).recurrence_until_prompt);
            return;
          }

          if (value === 'count') {
            await context.scene.update({ recEndMode: 'count' }, { step: undefined });
            await context.send(t(lang).recurrence_count_prompt);
            return;
          }

          return;
        }

        // Text input — depends on recEndMode
        const text = getMessageText(context);
        if (!text) return;

        const { recEndMode, recurrenceRule } = context.scene.state;

        if (recEndMode === 'until') {
          const parsed = parseSimpleDate(text, user?.timezone ?? 'UTC');
          if (!parsed) {
            await context.send(t(lang).recurrence_until_prompt);
            return;
          }
          const untilStr = parsed
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d{3}/, '');
          await context.scene.update({
            recurrenceRule: `${recurrenceRule};UNTIL=${untilStr}`,
            recEndMode: undefined,
          });
          return;
        }

        if (recEndMode === 'count') {
          const n = Number(text.trim());
          if (!n || n < 1 || !Number.isInteger(n)) {
            await context.send(t(lang).recurrence_count_prompt);
            return;
          }
          await context.scene.update({
            recurrenceRule: `${recurrenceRule};COUNT=${n}`,
            recEndMode: undefined,
          });
          return;
        }

        // Shouldn't reach here, but handle gracefully
        await context.scene.update({});
      })
      // Step 5: Description (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const lang = getSceneLang(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_description_prompt, {
            reply_markup: skipKeyboard(lang, 5),
          });
          return;
        }

        if (isCallbackQuery(context)) {
          const data = getCallbackData(context)!;
          if (data === `${CB.ADD_SKIP}:5`) {
            await answerCallback(context);
            await context.scene.update({});
            return;
          }
          await answerCallback(context);
          return;
        }

        const text = getMessageText(context);
        if (!text) return;
        await context.scene.update({ description: text });
      })
      // Step 6: Location → create event (text + skip button)
      .step(['message', 'callback_query'], async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (context.scene.step.firstTime) {
          await context.send(t(lang).add_location_prompt, {
            reply_markup: skipKeyboard(lang, 6),
          });
          return;
        }
        if (!user) return;

        let location: string | undefined;

        if (isCallbackQuery(context)) {
          const data = getCallbackData(context)!;
          if (data === `${CB.ADD_SKIP}:6`) {
            await answerCallback(context);
            location = undefined;
          } else {
            await answerCallback(context);
            return;
          }
        } else {
          const text = getMessageText(context);
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
