// src/bot/scenes/add-event.scene.ts

import { TZDate } from '@date-fns/tz';
import { Scene } from '@gramio/scenes';
import { addMinutes, endOfDay } from 'date-fns';
import { CB, t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { parseDuration, parseRecurrence, parseSimpleDate } from '../../utils/date.ts';
import {
  cancelKeyboard,
  eventActionsKeyboard,
  recurrenceEndKeyboard,
  recurrenceKeyboard,
  sceneHelpKeyboard,
  skipKeyboard,
} from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { AddEventState } from './types.ts';

export function applyDefaultDuration(startAt: string, defaultMinutes: number): string {
  return addMinutes(new Date(startAt), defaultMinutes).toISOString();
}

type WizardDateTimeResult =
  | { kind: 'complete'; startAt: string }
  | { kind: 'needs_time'; localDate: string }
  | { kind: 'ambiguous_number' }
  | { kind: 'invalid' };

function localDateKey(date: Date, timezone: string): string {
  const local = new TZDate(date.getTime(), timezone);
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, '0'),
    String(local.getDate()).padStart(2, '0'),
  ].join('-');
}

function parseClockInput(input: string): { hour: number; minute: number } | null {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(?:(?:at|в)\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|утра|дня|вечера|ночи)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3];
  if (minute > 59 || hour > 23) return null;
  if (period && hour > 12) return null;
  if (period === 'pm' || period === 'дня' || period === 'вечера') {
    if (hour < 12) hour += 12;
  } else if ((period === 'am' || period === 'утра' || period === 'ночи') && hour === 12) {
    hour = 0;
  }
  return { hour, minute };
}

function isDateOnlyInput(input: string): boolean {
  const text = input.trim().toLowerCase();
  if (/^(today|сегодня|tomorrow|завтра|послезавтра|day after tomorrow)$/.test(text)) return true;
  if (/^(?:[a-zа-яё]+\s+\d{1,2}|\d{1,2}\s+[a-zа-яё]+)$/.test(text)) return !/:\d{2}\b/.test(text);
  return false;
}

function dateFromBareDay(day: number, timezone: string, refDate?: Date): Date | null {
  const ref = refDate ? new TZDate(refDate.getTime(), timezone) : TZDate.tz(timezone);
  const candidate = new TZDate(ref.getFullYear(), ref.getMonth(), day, 0, 0, 0, 0, timezone);
  return candidate.getMonth() === ref.getMonth() && candidate.getDate() === day ? new Date(candidate.getTime()) : null;
}

export function parseWizardDateTime(
  input: string,
  timezone: string,
  pendingDate?: string,
  refDate?: Date,
): WizardDateTimeResult {
  const trimmed = input.trim();

  if (pendingDate) {
    const clock = parseClockInput(trimmed);
    if (!clock) return { kind: 'invalid' };
    const [year, month, day] = pendingDate.split('-').map(Number);
    const local = new TZDate(year!, month! - 1, day!, clock.hour, clock.minute, 0, 0, timezone);
    return { kind: 'complete', startAt: new Date(local.getTime()).toISOString() };
  }

  const bareNumber = /^(\d{1,2})$/.exec(trimmed);
  if (bareNumber) {
    const value = Number(bareNumber[1]);
    if (value >= 24 && value <= 31) {
      const date = dateFromBareDay(value, timezone, refDate);
      return date ? { kind: 'needs_time', localDate: localDateKey(date, timezone) } : { kind: 'invalid' };
    }
    if (value >= 1 && value <= 23) return { kind: 'ambiguous_number' };
  }

  const combinedDateTime = /^(.*?)\s+(?:(?:at|в)\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|утра|дня|вечера|ночи)?)$/i.exec(
    trimmed,
  );
  if (combinedDateTime) {
    const datePart = combinedDateTime[1]!.trim();
    const clock = parseClockInput(combinedDateTime[2]!);
    const date = parseSimpleDate(datePart, timezone, refDate);
    if (date && clock) {
      const localDate = localDateKey(date, timezone);
      const [year, month, day] = localDate.split('-').map(Number);
      const local = new TZDate(year!, month! - 1, day!, clock.hour, clock.minute, 0, 0, timezone);
      return { kind: 'complete', startAt: new Date(local.getTime()).toISOString() };
    }
  }

  const parsed = parseSimpleDate(trimmed, timezone, refDate);
  if (!parsed) return { kind: 'invalid' };
  if (isDateOnlyInput(trimmed)) return { kind: 'needs_time', localDate: localDateKey(parsed, timezone) };
  return { kind: 'complete', startAt: parsed.toISOString() };
}

function recurrenceUntilDate(input: string, timezone: string, startAt?: string): Date | null {
  const bareDay = /^(\d{1,2})$/.exec(input.trim());
  if (bareDay && startAt) {
    const start = new TZDate(new Date(startAt), timezone);
    const day = Number(bareDay[1]);
    const candidate = new TZDate(start.getFullYear(), start.getMonth(), day, 0, 0, 0, 0, timezone);
    if (candidate.getMonth() === start.getMonth() && candidate.getDate() === day) return new Date(candidate.getTime());
  }
  return parseSimpleDate(input, timezone, startAt ? new Date(startAt) : undefined);
}

function withRecurrenceEnd(rule: string, suffix: string): string {
  const base = rule
    .split(';')
    .filter((part) => !part.startsWith('UNTIL=') && !part.startsWith('COUNT='))
    .join(';');
  return `${base};${suffix}`;
}

function recurrenceUntilValue(date: Date, timezone: string): string {
  const localEnd = endOfDay(new TZDate(date.getTime(), timezone));
  return new Date(localEnd.getTime()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function createAddEventScene(
  eventService: EventService,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
) {
  return (
    new Scene('add_event')
      .state<AddEventState>()
      .extend(userComposer)
      // Step 0: Title (text + cancel button)
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        if (context.is('callback_query')) {
          await context.answer();
          await context.scene.exit();
          await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
          return;
        }
        if (context.scene.step.firstTime) {
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
      // Step 1: Date/Time (text + cancel button)
      .step(['message', 'callback_query'], async (context) => {
        const { lang, dbUser: user } = context;
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
        const text = context.text;
        if (!text) return;
        const timezone = user?.timezone ?? 'UTC';
        const parsed = parseWizardDateTime(text, timezone, context.scene.state.pendingDate);

        if (parsed.kind === 'ambiguous_number') {
          await context.send(
            lang === 'ru'
              ? 'Уточни, пожалуйста: это число месяца или время? Например: «15 сен» или «15:00».'
              : 'Please clarify: is that a day of the month or a time? For example: “Sep 15” or “15:00”.',
            { reply_markup: cancelKeyboard(lang) },
          );
          return;
        }

        if (parsed.kind === 'needs_time') {
          await context.scene.update({ pendingDate: parsed.localDate }, { step: undefined });
          await context.send(
            lang === 'ru'
              ? `📅 Дата: ${parsed.localDate}. Во сколько? Например: «19:00» или «7 вечера».`
              : `📅 Date: ${parsed.localDate}. What time? For example: “19:00” or “7 pm”.`,
            { reply_markup: cancelKeyboard(lang) },
          );
          return;
        }

        if (parsed.kind === 'invalid') {
          await context.send(
            lang === 'ru'
              ? 'Не могу разобрать дату и время. Например: «25 сен 19:00», «завтра 18:00».'
              : 'I can\'t parse that date and time. Try: “Sep 25 19:00” or “tomorrow 18:00”.',
            { reply_markup: sceneHelpKeyboard(lang) },
          );
          return;
        }

        await context.scene.update({ startAt: parsed.startAt, pendingDate: undefined });
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

        // Handle cancel/skip callbacks
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
      // Step 3: Recurrence — buttons for common choices, free text for custom rules.
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_prompt, {
            reply_markup: recurrenceKeyboard(lang),
          });
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
            await context.scene.update({ recurrenceRule: null }, { step: undefined });
            await context.scene.step.go(5, true);
            return;
          }

          if (value === 'custom') {
            await context.send(t(lang).recurrence_custom_prompt, { reply_markup: cancelKeyboard(lang) });
            return;
          }

          await context.scene.update({ recurrenceRule: `FREQ=${value}` });
          return;
        }

        const text = context.text?.trim();
        if (!text) return;
        const parsed = parseRecurrence(text);
        if (!parsed) {
          await context.send(
            lang === 'ru'
              ? 'Не понял правило повторения. Например: «каждые 2 недели», «ежедневно».'
              : 'I could not parse that recurrence. Try “every 2 weeks” or “daily”.',
            { reply_markup: recurrenceKeyboard(lang) },
          );
          return;
        }
        const interval = parsed.interval === 1 ? '' : `;INTERVAL=${parsed.interval}`;
        await context.scene.update({ recurrenceRule: `FREQ=${parsed.freq}${interval}` });
      })
      // Step 4: Recurrence end — buttons plus direct date/count text.
      .step(['message', 'callback_query'], async (context) => {
        const { lang } = context;
        if (context.scene.step.firstTime) {
          await context.send(t(lang).recurrence_end_prompt, {
            reply_markup: recurrenceEndKeyboard(lang),
          });
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
        const { recurrenceRule, recEndMode, startAt } = context.scene.state;
        if (!recurrenceRule) {
          await context.scene.exit();
          return;
        }

        if (!recEndMode && /^\d+$/.test(text)) {
          await context.send(
            lang === 'ru'
              ? `«${text}» — это ${text}-е число или ${text} повторений? Сначала выбери «До даты» или «N повторений».`
              : `Does “${text}” mean day ${text} or ${text} repeats? Choose “Until date” or “N repeats” first.`,
            { reply_markup: recurrenceEndKeyboard(lang) },
          );
          return;
        }

        if (recEndMode === 'count') {
          const count = Number(text);
          if (!Number.isInteger(count) || count < 1 || count > 999) {
            await context.send(
              lang === 'ru' ? 'Введите число повторений от 1 до 999.' : 'Enter a repeat count from 1 to 999.',
              { reply_markup: cancelKeyboard(lang) },
            );
            return;
          }
          await context.scene.update({
            recurrenceRule: withRecurrenceEnd(recurrenceRule, `COUNT=${count}`),
            recEndMode: undefined,
          });
          return;
        }

        if (/^(?:forever|no end|бесконечно|без конца)$/i.test(text)) {
          await context.scene.update({ recEndMode: undefined });
          return;
        }

        const timezone = context.dbUser?.timezone ?? 'UTC';
        const untilDate = recurrenceUntilDate(text, timezone, startAt);
        if (!untilDate) {
          await context.send(
            lang === 'ru'
              ? 'Не понял дату окончания. Например: «26 сен» или просто «26».'
              : 'I could not parse the end date. Try “Sep 26” or just “26”.',
            { reply_markup: cancelKeyboard(lang) },
          );
          return;
        }
        const localUntilEnd = endOfDay(new TZDate(untilDate.getTime(), timezone));
        const until = recurrenceUntilValue(untilDate, timezone);
        if (startAt && localUntilEnd.getTime() < new Date(startAt).getTime()) {
          await context.send(
            lang === 'ru' ? 'Дата окончания не может быть раньше начала события.' : 'End date cannot be before the event.',
            { reply_markup: cancelKeyboard(lang) },
          );
          return;
        }
        await context.scene.update({
          recurrenceRule: withRecurrenceEnd(recurrenceRule, `UNTIL=${until}`),
          recEndMode: undefined,
        });
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
          if (data === CB.ADD_CANCEL) {
            await context.answer();
            await context.scene.exit();
            await context.send(lang === 'ru' ? 'Добавление отменено.' : 'Event creation cancelled.');
            return;
          }
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
          reply_markup: eventActionsKeyboard(event.id, lang),
        });
      })
  );
}
