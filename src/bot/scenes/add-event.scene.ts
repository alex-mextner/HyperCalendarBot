// src/bot/scenes/add-event.scene.ts

import { TZDate } from '@date-fns/tz';
import { Scene } from '@gramio/scenes';
import { addDays, addMinutes, endOfDay } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import { handleCalculate } from '../../services/ai/tool-handlers/calculate.ts';
import { type CalendarDay, localMidnightInstant } from '../../services/calendar/wall-clock.ts';
import { resolveWizardWallTime } from '../../services/calendar/wall-time-adapters.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import type { LocationVerificationService } from '../../services/location/location-verification-service.ts';
import { formatCalendarDateMedium, parseDuration, parseRecurrence, parseSimpleDate } from '../../utils/date.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { AddEventParams, AddEventState } from './types.ts';

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
  if (minute > 59 || hour > 23 || (period && (hour < 1 || hour > 12))) return null;
  if (period === 'pm' || period === 'дня' || period === 'вечера') {
    if (hour < 12) hour += 12;
  } else if (period && hour === 12) hour = 0;
  return { hour, minute };
}

function calendarDate(year: number, month: number, day: number, timezone: string): Date | null {
  const date = new TZDate(year, month - 1, day, 12, 0, 0, 0, timezone);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? new Date(date.getTime())
    : null;
}

/** Parses the shared parser's plain `YYYY-MM-DD` `Schedule.startDate`/`endDateExclusive` into the
 * `CalendarDay` shape `localMidnightInstant` expects. */
function calendarDayFromIso(dateIso: string): CalendarDay {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}
function parseWizardDate(input: string, timezone: string, refDate = new Date(), bareDay = false): Date | null {
  const ref = new TZDate(refDate.getTime(), timezone);
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^(?:на|в)\s+/, '');
  const relative: { [key: string]: number } = {
    today: 0,
    сегодня: 0,
    tomorrow: 1,
    завтра: 1,
    послезавтра: 2,
    'day after tomorrow': 2,
  };
  const offset = relative[text];
  if (offset !== undefined) return addDays(ref, offset);
  const weekdays: { [key: string]: number } = {
    пн: 1,
    понедельник: 1,
    mon: 1,
    monday: 1,
    вт: 2,
    вторник: 2,
    tue: 2,
    tuesday: 2,
    ср: 3,
    среда: 3,
    среду: 3,
    wed: 3,
    wednesday: 3,
    чт: 4,
    четверг: 4,
    thu: 4,
    thursday: 4,
    пт: 5,
    пятница: 5,
    пятницу: 5,
    fri: 5,
    friday: 5,
    сб: 6,
    суббота: 6,
    субботу: 6,
    sat: 6,
    saturday: 6,
    вс: 0,
    воскресенье: 0,
    sun: 0,
    sunday: 0,
  };
  const weekday = weekdays[text];
  if (weekday !== undefined) return addDays(ref, (weekday - ref.getDay() + 7) % 7 || 7);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), timezone);
  const numeric = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?$/.exec(text);
  if (numeric)
    return calendarDate(Number(numeric[3] ?? ref.getFullYear()), Number(numeric[2]), Number(numeric[1]), timezone);
  if (bareDay && /^\d{1,2}$/.test(text))
    return calendarDate(ref.getFullYear(), ref.getMonth() + 1, Number(text), timezone);
  const withYear = /^(.*[a-zа-яё])\s+(\d{4})$/i.exec(text);
  const monthText = withYear ? withYear[1]! : text;
  if (!/^(?:[a-zа-яё]+\s+\d{1,2}|\d{1,2}\s+[a-zа-яё]+)$/.test(monthText)) return null;
  const monthRef = withYear ? new TZDate(Number(withYear[2]), 0, 1, 12, timezone) : ref;
  return parseSimpleDate(monthText, timezone, monthRef);
}

function completeWizardTime(
  localDate: string,
  clock: { hour: number; minute: number },
  timezone: string,
): WizardDateTimeResult {
  const time = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  const result = handleCalculate({ expression: `${localDate} ${time} ${timezone} to UTC` });
  return result.success && result.output ? { kind: 'complete', startAt: result.output } : { kind: 'invalid' };
}

export function parseWizardDateTime(
  input: string,
  timezone: string,
  pendingDate?: string,
  refDate = new Date(),
): WizardDateTimeResult {
  const text = input.trim();
  const clock = parseClockInput(text);
  if (pendingDate && clock) return completeWizardTime(pendingDate, clock, timezone);
  if (/^\d{1,2}$/.test(text)) {
    const value = Number(text);
    if (value >= 1 && value <= 23) return { kind: 'ambiguous_number' };
    const date = parseWizardDate(text, timezone, refDate, true);
    return date ? { kind: 'needs_time', localDate: localDateKey(date, timezone) } : { kind: 'invalid' };
  }
  if (clock) return completeWizardTime(localDateKey(refDate, timezone), clock, timezone);
  const combined = /^(.*?)\s+(?:(?:at|в)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm|утра|дня|вечера|ночи)?)$/i.exec(text);
  if (combined) {
    const day = parseWizardDate(combined[1]!, timezone, refDate, true);
    const time = parseClockInput(combined[2]!);
    if (day && time) return completeWizardTime(localDateKey(day, timezone), time, timezone);
  }
  const date = parseWizardDate(text, timezone, refDate);
  if (date) return { kind: 'needs_time', localDate: localDateKey(date, timezone) };
  return { kind: 'invalid' };
}

/** Button label for one ambiguous-time candidate: a bare "HH:MM" as-is, an offset-qualified DST-fold instant as "HH:MM (UTCoffset)". */
function formatTimeCandidate(candidate: string): string {
  const offsetInstant = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}):\d{2}([+-]\d{2}:\d{2})$/.exec(candidate);
  return offsetInstant ? `${offsetInstant[1]} (UTC${offsetInstant[2]})` : candidate;
}

/**
 * Resolves one of the two candidates offered for an ambiguous time selection to a UTC instant.
 * A bare "HH:MM" candidate (bare-hour ambiguity) is re-run through the shared parser as literal
 * 24h input, anchored to the same pendingDate/timezone — never re-guessed, and still DST-checked.
 * An offset-qualified instant (DST-fold ambiguity) names its exact UTC offset, but the callback
 * data carrying it is client-controlled, so it is only accepted if it is exactly one of the two
 * candidates the parser itself would (re-)offer for that HH:MM on this same pendingDate — never
 * an arbitrary attacker-supplied date/offset smuggled through a crafted "add:time:<iso>" click.
 */
function resolveChosenCandidate(
  candidate: string,
  pendingDate: string,
  timezone: string,
): { startAt: string } | { foldCandidates: readonly [string, string] } | null {
  if (/^\d{2}:\d{2}$/.test(candidate)) {
    const resolution = resolveWizardWallTime(candidate, { selectedDate: pendingDate, timezone });
    if (resolution.kind === 'complete' && resolution.schedule.kind === 'timed')
      return { startAt: resolution.schedule.startAt };
    // The chosen bare-hour reading can itself fall in a DST fold: ask which of the two instants.
    return resolution.kind === 'ambiguous_instant' ? { foldCandidates: resolution.candidates } : null;
  }
  const offsetInstant = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}[+-]\d{2}:\d{2}$/.exec(candidate);
  if (!offsetInstant || offsetInstant[1] !== pendingDate) return null;
  const resolution = resolveWizardWallTime(offsetInstant[2]!, { selectedDate: pendingDate, timezone });
  if (resolution.kind !== 'ambiguous_instant' || !resolution.candidates.includes(candidate)) return null;
  return { startAt: new Date(candidate).toISOString() };
}

function recurrenceUntilDate(input: string, timezone: string, startAt?: string): Date | null {
  return parseWizardDate(input, timezone, startAt && /\d/.test(input) ? new Date(startAt) : new Date(), true);
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
  return new Date(localEnd.getTime())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function wizardKeyboard(
  step: number,
  lang: Lang,
  opts: { number?: string; pendingDate?: string; timeCandidates?: readonly [string, string] } = {},
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const wizardText = t(lang).addWizard;
  if (step === 1) {
    if (opts.timeCandidates) {
      for (const candidate of opts.timeCandidates)
        kb.text(formatTimeCandidate(candidate), `${CB.ADD_TIME_CHOICE}:${candidate}`);
      kb.row();
    } else if (opts.pendingDate) {
      kb.text(wizardText.allDay, CB.ADD_ALL_DAY).text(wizardText.changeDate, CB.ADD_CHANGE_DATE).row();
    } else {
      kb.text(wizardText.today, 'add:date:today').text(wizardText.tomorrow, 'add:date:tomorrow').row();
    }
  }
  if (step === 2)
    kb.text(wizardText.duration30, 'add:duration:30')
      .text(wizardText.duration60, 'add:duration:60')
      .text(wizardText.duration120, 'add:duration:120')
      .row();
  if (step === 3) {
    kb.text(wizardText.none, `${CB.ADD_RECURRENCE}:none`).row();
    for (const freq of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const)
      kb.text(wizardText.frequencies[freq], `${CB.ADD_RECURRENCE}:${freq}`).row();
  }
  if (step === 4) {
    if (opts.number)
      kb.text(wizardText.untilChoice(opts.number), `${CB.ADD_REC_END}:until:${opts.number}`)
        .text(wizardText.countChoice(opts.number), `${CB.ADD_REC_END}:count:${opts.number}`)
        .row();
    kb.text(wizardText.noEnd, `${CB.ADD_REC_END}:forever`)
      .text(wizardText.untilDate, `${CB.ADD_REC_END}:until`)
      .text(wizardText.repeatCount, `${CB.ADD_REC_END}:count`)
      .row();
  }
  if ([2, 5, 6].includes(step)) kb.text(t(lang).skip, `${CB.ADD_SKIP}:${step}`).row();
  if (step === 7) kb.text(wizardText.confirm, 'add:confirm').row();
  if (step > 0) kb.text(wizardText.back, `add:back:${step}`);
  return kb.text(wizardText.cancel, CB.ADD_CANCEL);
}

function draftPreview(state: AddEventState, lang: Lang, timezone: string): string {
  const wizardText = t(lang).addWizard;
  const local = (value: string) =>
    new Intl.DateTimeFormat(lang, { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const field = (value: string | undefined, limit: number) =>
    escapeHtml(value ? value.slice(0, limit) + (value.length > limit ? '…' : '') : wizardText.none);
  const dateLine = state.startAt
    ? state.allDay
      ? `${formatCalendarDateMedium(state.startAt.slice(0, 10), lang)} (${wizardText.allDay})`
      : local(state.startAt)
    : '—';
  const lines = [
    `<b>${wizardText.preview}</b>`,
    `${wizardText.title}: ${field(state.title, 300)}`,
    `${wizardText.date}: ${dateLine} (${escapeHtml(timezone)})`,
  ];
  if (state.endAt && !state.allDay) lines.push(`${wizardText.end}: ${local(state.endAt)}`);
  let repeat: string = wizardText.none;
  const freq = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(state.recurrenceRule ?? '')?.[1];
  if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'MONTHLY' || freq === 'YEARLY') {
    repeat = wizardText.frequencies[freq];
    const interval = /INTERVAL=(\d+)/.exec(state.recurrenceRule ?? '')?.[1];
    const count = /COUNT=(\d+)/.exec(state.recurrenceRule ?? '')?.[1];
    const until = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(state.recurrenceRule ?? '');
    if (interval) repeat += ` · ${wizardText.interval(Number(interval))}`;
    if (count) repeat += ` · ${wizardText.count(Number(count))}`;
    if (until)
      repeat += ` · ${wizardText.until(local(`${until[1]}-${until[2]}-${until[3]}T${until[4]}:${until[5]}:${until[6]}Z`))}`;
  }
  lines.push(
    `${wizardText.repeat}: ${repeat}`,
    `${wizardText.description}: ${field(state.description, 1300)}`,
    `${wizardText.location}: ${field(state.location, 500)}`,
    '',
    wizardText.previewHint,
  );
  return lines.join('\n');
}

export function createAddEventScene(
  eventService: EventService,
  userComposer: UserResolverComposer,
  actionLogRepo?: ActionLogRepository,
  onEventCreated?: (userId: number, eventId: number) => Promise<void>,
  locationVerification?: Pick<LocationVerificationService, 'verifyEventLocation'>,
) {
  // Bounded FIFO of actual confirmations, not abandoned drafts; prevents concurrent duplicate writes.
  const submissions = new Map<string, Promise<number>>();
  const scene = new Scene('add_event').params<AddEventParams>().state<AddEventState>().extend(userComposer);
  for (let step = 0; step < 8; step++) {
    scene.step(['message', 'callback_query'], async (context) => {
      const { lang, dbUser: user } = context;
      if (!user) return;
      const wizardText = t(lang).addWizard;
      const state = context.scene.state;
      const timezone = state.timezone ?? context.scene.params?.timezone ?? user.timezone;
      const show = async (text: string, number?: string, html = false, timeCandidates?: readonly [string, string]) => {
        const chunks = splitMessage(text, 4000, html ? 'HTML' : undefined);
        for (const [index, chunk] of chunks.entries()) {
          const last = index === chunks.length - 1;
          const message = await context.send(chunk, {
            ...(last
              ? { reply_markup: wizardKeyboard(step, lang, { number, pendingDate: state.pendingDate, timeCandidates }) }
              : {}),
            ...(html ? { parse_mode: 'HTML' as const } : {}),
          });
          if (last) await context.scene.update({ promptMessageId: message.id }, { step: undefined });
        }
      };
      if (context.scene.step.firstTime) {
        if (step === 0 && context.scene.params?.title && !state.title) {
          const params = context.scene.params;
          await context.scene.update(
            {
              title: params.title,
              timezone,
              groupId: params.groupId,
              pendingDate: params.pendingDate,
              startAt: params.startAt,
            },
            { step: params.startAt ? 2 : 1 },
          );
          return;
        }
        if (step === 0)
          await context.scene.update({ timezone, groupId: context.scene.params?.groupId }, { step: undefined });
        const prompts = [
          t(lang).add_title_prompt,
          state.pendingDate ? wizardText.askTime(state.pendingDate) : t(lang).add_time_prompt,
          wizardText.duration(user.default_event_duration_minutes ?? 60),
          t(lang).recurrence_prompt,
          t(lang).recurrence_end_prompt,
          t(lang).add_description_prompt,
          t(lang).add_location_prompt,
        ];
        await show(step === 7 ? draftPreview(state, lang, timezone) : prompts[step]!, undefined, step === 7);
        return;
      }
      let text = context.is('message') ? context.text?.trim() : undefined;
      let callback = '';
      if (context.is('callback_query')) {
        callback = context.data ?? '';
        if (state.promptMessageId !== undefined && context.message?.id !== state.promptMessageId) {
          await context.answer({ text: wizardText.stale });
          return;
        }
        await context.answer();
        if (callback === CB.ADD_CANCEL) {
          await context.scene.exit();
          await context.send(wizardText.cancelled);
          return;
        }
        if (callback === `add:back:${step}` && step > 0) {
          const previous = step === 5 && !state.recurrenceRule ? 3 : step === 3 && state.allDay ? 1 : step - 1;
          await context.scene.step.go(previous, true);
          return;
        }
        if (callback === CB.SCENE_HELP) {
          await context.scene.step.go(step, true);
          return;
        }
      }
      const skip = callback === `${CB.ADD_SKIP}:${step}` || (text !== undefined && /^(?:skip|пропустить)$/i.test(text));
      if (step === 0) {
        if (!text) {
          await show(t(lang).add_title_prompt);
          return;
        }
        await context.scene.update({ title: text });
      } else if (step === 1 && state.pendingDate) {
        // A date is already chosen — resolve TIME OF DAY / all-day via the shared, DST-aware
        // parser (GH-650/GH-652: replaces the old completeWizardTime, which silently guessed a
        // bare "2" as 02:00 instead of asking — see wall-time-parser.ts's bare-hour invariant).
        const pendingDate = state.pendingDate;
        if (callback === CB.ADD_CHANGE_DATE) {
          await context.scene.update(
            { pendingDate: undefined, startAt: undefined, endAt: undefined, allDay: false },
            { step: undefined },
          );
          await show(t(lang).add_time_prompt);
          return;
        }
        if (callback === CB.ADD_ALL_DAY) text = 'весь день';
        const chosenCandidate = callback.startsWith(`${CB.ADD_TIME_CHOICE}:`)
          ? callback.slice(CB.ADD_TIME_CHOICE.length + 1)
          : undefined;
        if (chosenCandidate !== undefined) {
          const chosen = resolveChosenCandidate(chosenCandidate, pendingDate, timezone);
          if (!chosen) {
            await show(wizardText.invalidDate);
            return;
          }
          if ('foldCandidates' in chosen) {
            await show(wizardText.ambiguousTime, undefined, false, chosen.foldCandidates);
            return;
          }
          await context.scene.update({
            startAt: chosen.startAt,
            endAt: undefined,
            pendingDate: undefined,
            allDay: false,
          });
          return;
        }
        if (!text) {
          await show(wizardText.unsupported);
          return;
        }
        const resolution = resolveWizardWallTime(text, { selectedDate: pendingDate, timezone });
        switch (resolution.kind) {
          case 'complete':
            if (resolution.schedule.kind === 'timed') {
              await context.scene.update({
                startAt: resolution.schedule.startAt,
                endAt: undefined,
                pendingDate: undefined,
                allDay: false,
              });
            } else {
              // All-day is a DATE range [startDate, endDateExclusive), not a UTC-midnight 24h
              // block: store each boundary as the actual local-midnight instant in this timezone
              // (offset-preserving ISO, e.g. "2027-03-10T00:00:00.000-05:00") so the date prefix
              // Google's mapper and free-slots.ts's allDaySpan already read, and the julianday()
              // day-range query in EventRepository.getVisibleInRange, all agree with the calendar
              // day the user actually picked — a naive "...T00:00:00.000Z" reads back as the
              // previous local day in any negative-offset zone (GH-652 parent review).
              const startAt = localMidnightInstant(calendarDayFromIso(resolution.schedule.startDate), timezone);
              const endAt = localMidnightInstant(calendarDayFromIso(resolution.schedule.endDateExclusive), timezone);
              if (!startAt || !endAt) {
                await show(wizardText.invalidDate);
                return;
              }
              await context.scene.update({ startAt, endAt, pendingDate: undefined, allDay: true }, { step: 3 });
            }
            return;
          case 'ambiguous_number':
          case 'ambiguous_instant':
            await show(wizardText.ambiguousTime, undefined, false, resolution.candidates);
            return;
          case 'clarify':
            await show(wizardText.timeUnknown);
            return;
          case 'invalid': {
            // Not recognized as any kind of time phrase — it might still be a full date
            // correction ("26 сен 20:00"), which is the free-form date grammar's job,
            // unchanged from before.
            const corrected = resolution.reason === 'unparseable' ? parseWizardDateTime(text, timezone) : null;
            if (corrected?.kind === 'needs_time') {
              await context.scene.update(
                { pendingDate: corrected.localDate, startAt: undefined, endAt: undefined, allDay: false },
                { step: undefined },
              );
              await show(wizardText.askTime(corrected.localDate));
              return;
            }
            if (corrected?.kind === 'complete') {
              await context.scene.update({
                startAt: corrected.startAt,
                pendingDate: undefined,
                endAt: undefined,
                allDay: false,
              });
              return;
            }
            await show(wizardText.invalidDate);
            return;
          }
          default:
            // Unreachable — selectedDate/pendingField are always supplied above.
            await show(wizardText.invalidDate);
        }
      } else if (step === 1) {
        // No date chosen yet — resolve the DATE. Free-form date grammar, unchanged.
        if (callback === 'add:date:today') text = 'today';
        if (callback === 'add:date:tomorrow') text = 'tomorrow';
        if (!text) {
          await show(wizardText.unsupported);
          return;
        }
        const parsed = parseWizardDateTime(text, timezone);
        if (parsed.kind === 'needs_time') {
          await context.scene.update(
            { pendingDate: parsed.localDate, startAt: undefined, endAt: undefined, allDay: false },
            { step: undefined },
          );
          await show(wizardText.askTime(parsed.localDate));
        } else if (parsed.kind === 'complete') {
          await context.scene.update({
            startAt: parsed.startAt,
            pendingDate: undefined,
            endAt: undefined,
            allDay: false,
          });
        } else await show(parsed.kind === 'ambiguous_number' ? wizardText.ambiguousDate : wizardText.invalidDate);
      } else if (step === 2) {
        const quick = /^add:duration:(30|60|120)$/.exec(callback)?.[1];
        const minutes = skip ? (user.default_event_duration_minutes ?? 60) : parseDuration(quick ?? text ?? '');
        if (!state.startAt) {
          await context.scene.step.go(1, true);
          return;
        }
        if (!minutes || !Number.isFinite(minutes) || minutes > 525600) {
          await show(wizardText.invalidDuration);
          return;
        }
        await context.scene.update({ endAt: applyDefaultDuration(state.startAt, minutes) });
      } else if (step === 3) {
        const value = /^ar:(none|DAILY|WEEKLY|MONTHLY|YEARLY|custom)$/.exec(callback)?.[1];
        if (value === 'none' || /^(?:нет|не повторять|без повторения|none|no|never)$/i.test(text ?? '')) {
          await context.scene.update({ recurrenceRule: null, recEndMode: undefined }, { step: 5 });
          return;
        }
        if (value === 'custom') {
          await show(t(lang).recurrence_custom_prompt);
          return;
        }
        const rule = value ? `FREQ=${value}` : undefined;
        const parsed = text ? parseRecurrence(text) : null;
        if (rule) await context.scene.update({ recurrenceRule: rule, recEndMode: undefined });
        else if (parsed && parsed.interval >= 1 && parsed.interval <= 999)
          await context.scene.update({
            recurrenceRule: `FREQ=${parsed.freq}${parsed.interval === 1 ? '' : `;INTERVAL=${parsed.interval}`}`,
            recEndMode: undefined,
          });
        else await show(wizardText.invalidRepeat);
      } else if (step === 4) {
        if (!state.recurrenceRule) {
          await context.scene.step.go(3, true);
          return;
        }
        const mode = /^are:(forever|until|count)(?::(\d{1,3}))?$/.exec(callback);
        let recEndMode = state.recEndMode;
        if (mode?.[1] === 'forever' || /^(?:forever|no end|бесконечно|без конца|никогда)$/i.test(text ?? '')) {
          await context.scene.update({
            recurrenceRule: state.recurrenceRule
              .split(';')
              .filter((part) => !/^(?:UNTIL|COUNT)=/.test(part))
              .join(';'),
            recEndMode: undefined,
          });
          return;
        }
        if (mode?.[1] === 'until' || mode?.[1] === 'count') {
          recEndMode = mode[1];
          await context.scene.update({ recEndMode }, { step: undefined });
          if (!mode[2]) {
            await show(recEndMode === 'until' ? t(lang).recurrence_until_prompt : t(lang).recurrence_count_prompt);
            return;
          }
          text = mode[2];
        }
        if (!text) {
          await show(wizardText.unsupported);
          return;
        }
        if (!recEndMode && /^\d+$/.test(text)) {
          await show(wizardText.ambiguousEnd(text), text);
          return;
        }
        const countMatch = /^(\d+)\s*(?:раз|повторений|повторения|повторение|times|repeats)?$/i.exec(text);
        const countWasWrittenExplicitly = !recEndMode && countMatch !== null && !/^\d+$/.test(text);
        if (recEndMode === 'count' || countWasWrittenExplicitly) {
          const count = countMatch ? Number(countMatch[1]) : 0;
          if (count < 1 || count > 999) {
            await show(wizardText.invalidCount);
            return;
          }
          await context.scene.update({
            recurrenceRule: withRecurrenceEnd(state.recurrenceRule, `COUNT=${count}`),
            recEndMode: undefined,
          });
          return;
        }
        const date = recurrenceUntilDate(text.replace(/^(?:до|until)\s+/i, ''), timezone, state.startAt);
        if (
          !date ||
          (state.startAt && endOfDay(new TZDate(date, timezone)).getTime() < new Date(state.startAt).getTime())
        ) {
          await show(wizardText.invalidEnd);
          return;
        }
        await context.scene.update({
          recurrenceRule: withRecurrenceEnd(state.recurrenceRule, `UNTIL=${recurrenceUntilValue(date, timezone)}`),
          recEndMode: undefined,
        });
      } else if (step === 5 || step === 6) {
        if (!skip && !text) {
          await show(wizardText.unsupported);
          return;
        }
        if (step === 5)
          await context.scene.update({ description: skip ? undefined : context.is('message') ? context.text : text });
        else await context.scene.update({ location: skip ? undefined : text });
      } else if (step === 7) {
        if (callback !== 'add:confirm') {
          await show(draftPreview(state, lang, timezone), undefined, true);
          return;
        }
        const { title, startAt, endAt, description, location, recurrenceRule } = state;
        if (!title || !startAt) {
          await show(wizardText.missing);
          return;
        }
        const key = `${user.telegram_id}:${context.chatId}:${state.promptMessageId}`;
        let saved = submissions.get(key);
        if (!saved) {
          saved = (async () => {
            if (state.createdEventId) return state.createdEventId;
            const event = eventService.createEvent({
              user_id: user.telegram_id,
              title,
              start_at: startAt,
              end_at: endAt,
              all_day: state.allDay,
              timezone,
              description,
              location,
              recurrence_rule: recurrenceRule ?? undefined,
              ...(state.groupId
                ? { owner_type: 'group' as const, group_id: state.groupId, created_by: user.telegram_id }
                : {}),
            });
            await context.scene.update({ createdEventId: event.id }, { step: undefined });
            actionLogRepo?.insert({
              user_id: user.telegram_id,
              chat_id: Number(context.chatId ?? user.telegram_id),
              action_type: 'scene',
              action_name: 'create_event',
              input_summary: title,
              result_summary: `id: ${event.id}`,
              target_event_id: event.id,
              metadata: JSON.stringify({ startAt, endAt, recurrenceRule }),
            });
            onEventCreated?.(user.telegram_id, event.id).catch((err) =>
              cmdLogger.error({ err, eventId: event.id }, 'Event saved; post-create delivery failed'),
            );
            if (event.location && locationVerification) {
              locationVerification
                .verifyEventLocation(event, user)
                .catch((err) =>
                  cmdLogger.error({ err, eventId: event.id }, 'Event saved; location verification failed'),
                );
            }
            return event.id;
          })();
          submissions.set(key, saved);
          if (submissions.size > 1000) {
            const oldest = submissions.keys().next().value;
            if (oldest) submissions.delete(oldest);
          }
        }
        try {
          const id = await saved;
          await context.scene.exit();
          const event = eventService.getEvent(id, user.telegram_id);
          if (!event) {
            await context.send(wizardText.saveFailed);
            return;
          }
          const receipt = splitMessage(
            `${t(lang).event_created(escapeHtml(title))}\n\n${formatEventDetail(event, timezone, lang)}`,
            4000,
            'HTML',
          );
          for (const [index, chunk] of receipt.entries()) {
            await context.send(chunk, {
              parse_mode: 'HTML',
              ...(index === receipt.length - 1 ? { reply_markup: eventActionsKeyboard(id, lang) } : {}),
            });
          }
        } catch (err) {
          cmdLogger.error({ err, userId: user.telegram_id }, 'Add-event save or receipt failed');
          await context.send(wizardText.saveFailed);
        }
      }
    });
  }
  return scene;
}
