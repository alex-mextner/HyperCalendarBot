// src/bot/scenes/add-event.scene.ts

import { Scene } from '@gramio/scenes';
import { addMinutes } from 'date-fns';
import { CB, t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import {
  combineLocalDateAndTime,
  formatInclusiveRruleUntil,
  hasExplicitTime,
  parseDuration,
  parseRecurrence,
  parseSimpleDate,
} from '../../utils/date.ts';
import {
  cancelKeyboard,
  eventCreatedActionsKeyboard,
  recurrenceEndKeyboard,
  recurrenceKeyboard,
  sceneHelpKeyboard,
  skipKeyboard,
} from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { AddEventState } from './types.ts';

export interface AddEventParams {
  initialTitle?: string;
  pendingDate?: string;
}

/** All add-event steps accept typed answers where text is meaningful. */
export const CALLBACK_ONLY_STEP_INDICES = new Set<number>();

export function applyDefaultDuration(startAt: string, defaultMinutes: number): string {
  return addMinutes(new Date(startAt), defaultMinutes).toISOString();
}

export function isSceneSkipText(text: string): boolean {
  return ['skip', 'пропустить', 'пропусти', 'нет', 'none', '-'].includes(text.trim().toLowerCase());
}

function buildRecurrenceRule(freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY', interval: number): string {
  return interval > 1 ? `FREQ=${freq};INTERVAL=${interval}` : `FREQ=${freq}`;
}

function appendRecurrenceCount(rule: string, count: number): string {
  const base = rule
    .split(';')
    .filter((part) => !part.startsWith('COUNT=') && !part.startsWith('UNTIL='))
    .join(';');
  return `${base};COUNT=${count}`;
}

function appendRecurrenceUntil(rule: string, until: Date, timezone: string): string {
  const base = rule
    .split(';')
    .filter((part) => !part.startsWith('COUNT=') && !part.startsWith('UNTIL='))
    .join(';');
  return `${base};UNTIL=${formatInclusiveRruleUntil(until, timezone)}`;
}

function isNoRecurrenceText(text: string): boolean {
  return ['нет', 'не повторять', 'no', 'none', "don't repeat", 'dont repeat'].includes(text.trim().toLowerCase());
}

function isForeverText(text: string): boolean {
  return ['бесконечно', 'навсегда', 'никогда', 'forever', 'no end'].includes(text.trim().toLowerCase());
}

function durationLabel(minutes: number, lang: 'en' | 'ru'): string {
  if (minutes >= 60 && minutes % 60 === 0) return lang === 'ru' ? `${minutes / 60}ч` : `${minutes / 60}h`;
  return lang === 'ru' ? `${minutes} мин` : `${minutes}m`;
}

export function createAddEventScene(
  eventService: EventService,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
) {
  return new Scene('add_event')
    .state<AddEventState>()
    .params<AddEventParams>()
    .extend(userComposer)
    .step(['message', 'callback_query'], async (context) => {
      const { lang } = context;
      if (context.is('callback_query')) {
        await context.answer();
        await context.scene.exit();
        await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
        return;
      }
      if (context.scene.step.firstTime) {
        const params = context.scene.params as AddEventParams;
        if (params?.initialTitle && params?.pendingDate) {
          await context.scene.update({ title: params.initialTitle, pendingDate: params.pendingDate }, { step: 1 });
          return;
        }
        await context.send(t(lang).add_title_prompt, { reply_markup: cancelKeyboard(lang) });
        return;
      }
      const text = context.text;
      if (!text?.trim()) {
        await context.send(t(lang).add_title_prompt, { reply_markup: cancelKeyboard(lang) });
        return;
      }
      await context.scene.update({ title: text.trim() });
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang, dbUser: user } = context;
      const timezone = user?.timezone ?? 'UTC';

      if (context.is('callback_query')) {
        await context.answer();
        await context.scene.exit();
        await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
        return;
      }
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_time_prompt, { reply_markup: cancelKeyboard(lang) });
        return;
      }

      const text = context.text?.trim();
      if (!text) return;

      const { pendingDate } = context.scene.state;
      if (pendingDate) {
        const combined = combineLocalDateAndTime(pendingDate, text, timezone);
        if (combined) {
          await context.scene.update({ startAt: combined.toISOString(), pendingDate: undefined });
          return;
        }

        const replacement = parseSimpleDate(text, timezone);
        if (replacement && hasExplicitTime(text)) {
          await context.scene.update({ startAt: replacement.toISOString(), pendingDate: undefined });
          return;
        }

        await context.send(
          lang === 'ru'
            ? '🕐 Во сколько? Например: 19:00, 7 вечера или 09:30.'
            : '🕐 What time? For example: 19:00, 7 pm, or 09:30.',
          { reply_markup: cancelKeyboard(lang) },
        );
        return;
      }

      const parsed = parseSimpleDate(text, timezone);
      if (!parsed) {
        await context.send(
          lang === 'ru'
            ? 'Не могу разобрать дату и время. Например: «завтра 15:00» или «25 сен 19:00».'
            : 'I can’t parse that date and time. Try “tomorrow 15:00” or “Sep 25 19:00”.',
          { reply_markup: sceneHelpKeyboard(lang) },
        );
        return;
      }

      if (!hasExplicitTime(text)) {
        await context.scene.update({ pendingDate: parsed.toISOString() }, { step: undefined });
        await context.send(
          lang === 'ru'
            ? `📅 Дата: ${text}. Теперь во сколько? Например: 19:00 или 7 вечера.`
            : `📅 Date: ${text}. What time? For example: 19:00 or 7 pm.`,
          { reply_markup: cancelKeyboard(lang) },
        );
        return;
      }

      await context.scene.update({ startAt: parsed.toISOString(), pendingDate: undefined });
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang } = context;
      const defaultMins = context.dbUser?.default_event_duration_minutes ?? 60;

      if (context.scene.step.firstTime) {
        const defaultText =
          lang === 'ru'
            ? `Если пропустить — поставлю ${durationLabel(defaultMins, lang)} по умолчанию.`
            : `If you skip it, I’ll use your ${durationLabel(defaultMins, lang)} default.`;
        await context.send(`${t(lang).add_duration_prompt}\n${defaultText}`, {
          reply_markup: skipKeyboard(lang, 2),
        });
        return;
      }

      if (context.is('callback_query')) {
        const data = context.data;
        if (data === CB.ADD_CANCEL) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }
        if (data === `${CB.ADD_SKIP}:2`) {
          await context.answer();
          const { startAt } = context.scene.state;
          if (startAt) {
            await context.scene.update({ endAt: applyDefaultDuration(startAt, defaultMins) });
          } else {
            await context.scene.exit();
          }
          return;
        }
        await context.answer();
        return;
      }

      const text = context.text?.trim();
      if (!text) return;

      const { startAt } = context.scene.state;
      if (!startAt) {
        await context.scene.exit();
        return;
      }

      if (isSceneSkipText(text)) {
        await context.scene.update({ endAt: applyDefaultDuration(startAt, defaultMins) });
        return;
      }

      const mins = parseDuration(text);
      if (!mins) {
        await context.send(
          lang === 'ru'
            ? 'Не понял длительность. Примеры: 1ч, 30м, 1ч30м. Или напишите «пропустить».'
            : 'I can’t parse that duration. Examples: 1h, 30m, 1h30m. Or type “skip”.',
          { reply_markup: skipKeyboard(lang, 2) },
        );
        return;
      }
      await context.scene.update({ endAt: addMinutes(new Date(startAt), mins).toISOString() });
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang } = context;
      if (context.scene.step.firstTime) {
        await context.send(t(lang).recurrence_prompt, { reply_markup: recurrenceKeyboard(lang) });
        return;
      }

      if (context.is('callback_query')) {
        const data = context.data;
        if (!data) return;
        if (data === CB.ADD_CANCEL) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }

        const value = data.replace(`${CB.ADD_RECURRENCE}:`, '');
        await context.answer();

        if (value === 'none') {
          await context.scene.update({ recurrenceRule: null, recurrenceInputMode: undefined }, { step: 5 });
          return;
        }
        if (value === 'custom') {
          await context.scene.update({ recurrenceInputMode: 'custom' }, { step: undefined });
          await context.send(t(lang).recurrence_custom_prompt, { reply_markup: cancelKeyboard(lang) });
          return;
        }
        if (['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(value)) {
          await context.scene.update({
            recurrenceRule: `FREQ=${value}`,
            recurrenceInputMode: undefined,
          });
        }
        return;
      }

      const text = context.text?.trim();
      if (!text) return;

      if (isNoRecurrenceText(text)) {
        await context.scene.update({ recurrenceRule: null, recurrenceInputMode: undefined }, { step: 5 });
        return;
      }

      const parsed = parseRecurrence(text);
      if (!parsed) {
        await context.send(
          lang === 'ru'
            ? 'Не понял повторение. Например: «каждый день», «каждые 2 недели», «каждый месяц» или «не повторять».'
            : 'I can’t parse that recurrence. Try “daily”, “every 2 weeks”, “monthly”, or “don’t repeat”.',
          { reply_markup: recurrenceKeyboard(lang) },
        );
        return;
      }

      await context.scene.update({
        recurrenceRule: buildRecurrenceRule(parsed.freq, parsed.interval),
        recurrenceInputMode: undefined,
      });
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang, dbUser: user } = context;
      const timezone = user?.timezone ?? 'UTC';

      if (context.scene.step.firstTime) {
        await context.send(t(lang).recurrence_end_prompt, { reply_markup: recurrenceEndKeyboard(lang) });
        return;
      }

      if (context.is('callback_query')) {
        const data = context.data;
        if (!data) return;
        if (data === CB.ADD_CANCEL) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }

        const value = data.replace(`${CB.ADD_REC_END}:`, '');
        await context.answer();
        if (value === 'forever') {
          await context.scene.update({ recEndMode: undefined });
          return;
        }
        if (value === 'until') {
          await context.scene.update({ recEndMode: 'until' }, { step: undefined });
          await context.send(t(lang).recurrence_until_prompt, { reply_markup: cancelKeyboard(lang) });
          return;
        }
        if (value === 'count') {
          await context.scene.update({ recEndMode: 'count' }, { step: undefined });
          await context.send(t(lang).recurrence_count_prompt, { reply_markup: cancelKeyboard(lang) });
          return;
        }
        return;
      }

      const text = context.text?.trim();
      if (!text) return;

      const { recurrenceRule, recEndMode } = context.scene.state;
      if (!recurrenceRule) {
        await context.scene.update({ recEndMode: undefined });
        return;
      }

      if (isForeverText(text)) {
        await context.scene.update({ recEndMode: undefined });
        return;
      }

      if (recEndMode === 'count' || (!recEndMode && /^\d+$/.test(text))) {
        const count = Number(text);
        if (!Number.isInteger(count) || count < 1 || count > 999) {
          await context.send(
            lang === 'ru' ? 'Введите число повторений от 1 до 999.' : 'Enter a repeat count from 1 to 999.',
            { reply_markup: cancelKeyboard(lang) },
          );
          return;
        }
        await context.scene.update({
          recurrenceRule: appendRecurrenceCount(recurrenceRule, count),
          recEndMode: undefined,
        });
        return;
      }

      if (recEndMode === 'until' || !recEndMode) {
        const until = parseSimpleDate(text, timezone);
        if (until) {
          await context.scene.update({
            recurrenceRule: appendRecurrenceUntil(recurrenceRule, until, timezone),
            recEndMode: undefined,
          });
          return;
        }
      }

      await context.send(
        lang === 'ru'
          ? 'Укажите дату окончания («26 сентября»), число повторений («3») или «бесконечно».'
          : 'Send an end date (“Sep 26”), a repeat count (“3”), or “forever”.',
        { reply_markup: recurrenceEndKeyboard(lang) },
      );
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang } = context;
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_description_prompt, { reply_markup: skipKeyboard(lang, 5) });
        return;
      }

      if (context.is('callback_query')) {
        const data = context.data;
        if (data === CB.ADD_CANCEL) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }
        if (data === `${CB.ADD_SKIP}:5`) {
          await context.answer();
          await context.scene.update({});
          return;
        }
        await context.answer();
        return;
      }

      const text = context.text?.trim();
      if (!text) return;
      if (isSceneSkipText(text)) {
        await context.scene.update({});
        return;
      }
      await context.scene.update({ description: text });
    })
    .step(['message', 'callback_query'], async (context) => {
      const { lang, dbUser: user } = context;
      if (context.scene.step.firstTime) {
        await context.send(t(lang).add_location_prompt, { reply_markup: skipKeyboard(lang, 6) });
        return;
      }
      if (!user) return;

      let location: string | undefined;
      if (context.is('callback_query')) {
        const data = context.data;
        if (data === CB.ADD_CANCEL) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }
        if (data === `${CB.ADD_SKIP}:6`) {
          await context.answer();
        } else {
          await context.answer();
          return;
        }
      } else {
        const text = context.text?.trim();
        if (!text) return;
        location = isSceneSkipText(text) ? undefined : text;
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

      actionLogRepo?.insert({
        user_id: user.telegram_id,
        chat_id: Number(context.chatId ?? user.telegram_id),
        action_type: 'scene',
        action_name: 'create_event',
        message_id: typeof context.id === 'number' ? context.id : undefined,
        input_summary: title,
        result_summary: `id: ${event.id}`,
        target_event_id: event.id,
        metadata: JSON.stringify({ startAt, endAt, recurrenceRule }),
      });

      onEventCreated?.(user.telegram_id, event.id).catch(() => {});

      await context.scene.exit();
      const detail = formatEventDetail(event, user.timezone, lang);
      await context.send(`${t(lang).event_created(title)}\n\n${detail}`, {
        parse_mode: 'HTML',
        reply_markup: eventCreatedActionsKeyboard(event.id, lang),
      });
    });
}
