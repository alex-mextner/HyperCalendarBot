// src/bot/scenes/add-event-steps.ts
// Add-event wizard step logic. It runs against AddEventRuntime — a narrow view of the scene context — so every
// step is a small named function instead of one branch of a single closure.

import { TZDate } from '@date-fns/tz';
import { endOfDay } from 'date-fns';
import type { InlineKeyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import type { LocationVerificationService } from '../../services/location/location-verification-service.ts';
import { parseDuration, parseRecurrence } from '../../utils/date.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import { eventActionsKeyboard } from '../keyboards.ts';
import {
  applyDefaultDuration,
  parseWizardDateTime,
  recurrenceUntilDate,
  recurrenceUntilValue,
  stripRecurrenceEnd,
  withRecurrenceEnd,
} from './add-event-input.ts';
import { draftPreview, wizardKeyboard } from './add-event-view.ts';
import type { AddEventParams, AddEventState } from './types.ts';

interface SendOptions {
  reply_markup?: InlineKeyboard;
  parse_mode?: 'HTML';
}

export interface AddEventCallback {
  data: string;
  messageId: number | undefined;
  answer(text?: string): Promise<unknown>;
}

/** What a wizard step needs from the scene context; the scene builds it once per update. */
export interface AddEventRuntime {
  step: number;
  firstTime: boolean;
  lang: Lang;
  user: User;
  state: AddEventState;
  params: AddEventParams | undefined;
  timezone: string;
  chatId: number | undefined;
  /** Set for message updates; `text` is the raw, untrimmed message text. */
  message: { text: string | undefined } | undefined;
  /** Set for callback-query updates. */
  callback: AddEventCallback | undefined;
  send(text: string, options?: SendOptions): Promise<{ id: number }>;
  update(patch: Partial<AddEventState>, options?: { step?: number }): Promise<unknown>;
  goTo(step: number): Promise<unknown>;
  exit(): unknown;
}

export interface AddEventDeps {
  eventService: EventService;
  actionLogRepo?: ActionLogRepository;
  onEventCreated?: (userId: number, eventId: number) => Promise<void>;
  locationVerification?: Pick<LocationVerificationService, 'verifyEventLocation'>;
  /** Bounded FIFO of actual confirmations, not abandoned drafts; prevents concurrent duplicate writes. */
  submissions: Map<string, Promise<number>>;
}

type Show = (text: string, number?: string, html?: boolean) => Promise<void>;

interface StepInput {
  rt: AddEventRuntime;
  show: Show;
  /** Trimmed message text; undefined for callbacks. */
  text: string | undefined;
  /** Callback data; empty for messages. */
  callback: string;
  skip: boolean;
}

const MAX_TRACKED_SUBMISSIONS = 1000;

function quickDateText(callback: string): string | undefined {
  if (callback === 'add:date:today') return 'today';
  if (callback === 'add:date:tomorrow') return 'tomorrow';
  return undefined;
}

function createShow(rt: AddEventRuntime): Show {
  return async (text, number, html = false) => {
    const chunks = splitMessage(text, 4000, html ? 'HTML' : undefined);
    for (const [index, chunk] of chunks.entries()) {
      const last = index === chunks.length - 1;
      const message = await rt.send(chunk, {
        ...(last ? { reply_markup: wizardKeyboard(rt.step, rt.lang, number) } : {}),
        ...(html ? { parse_mode: 'HTML' as const } : {}),
      });
      if (last) await rt.update({ promptMessageId: message.id }, { step: undefined });
    }
  };
}

function stepPrompts(rt: AddEventRuntime): string[] {
  const wizardText = t(rt.lang).addWizard;
  return [
    t(rt.lang).add_title_prompt,
    rt.state.pendingDate ? wizardText.askTime(rt.state.pendingDate) : t(rt.lang).add_time_prompt,
    wizardText.duration(rt.user.default_event_duration_minutes ?? 60),
    t(rt.lang).recurrence_prompt,
    t(rt.lang).recurrence_end_prompt,
    t(rt.lang).add_description_prompt,
    t(rt.lang).add_location_prompt,
  ];
}

async function skipToPrefilledStep(rt: AddEventRuntime, params: AddEventParams): Promise<void> {
  await rt.update(
    {
      title: params.title,
      timezone: rt.timezone,
      groupId: params.groupId,
      pendingDate: params.pendingDate,
      startAt: params.startAt,
    },
    { step: params.startAt ? 2 : 1 },
  );
}

async function promptStep(rt: AddEventRuntime, show: Show): Promise<void> {
  const { step, state, params } = rt;
  if (step === 0 && params?.title && !state.title) {
    await skipToPrefilledStep(rt, params);
    return;
  }
  if (step === 0) await rt.update({ timezone: rt.timezone, groupId: params?.groupId }, { step: undefined });
  const preview = step === 7;
  await show(preview ? draftPreview(state, rt.lang, rt.timezone) : stepPrompts(rt)[step]!, undefined, preview);
}

/** Handles cancel/back/help taps and stale prompts. Returns true when the update is fully handled. */
async function handleCallbackControl(rt: AddEventRuntime, callback: AddEventCallback) {
  const wizardText = t(rt.lang).addWizard;
  const { step, state } = rt;
  if (state.promptMessageId !== undefined && callback.messageId !== state.promptMessageId) {
    await callback.answer(wizardText.stale);
    return true;
  }
  await callback.answer();
  if (callback.data === CB.ADD_CANCEL) {
    await rt.exit();
    await rt.send(wizardText.cancelled);
    return true;
  }
  if (callback.data === `add:back:${step}` && step > 0) {
    await rt.goTo(step === 5 && !state.recurrenceRule ? 3 : step - 1);
    return true;
  }
  if (callback.data === CB.SCENE_HELP) {
    await rt.goTo(step);
    return true;
  }
  return false;
}

async function titleStep({ rt, show, text }: StepInput): Promise<void> {
  if (!text) {
    await show(t(rt.lang).add_title_prompt);
    return;
  }
  await rt.update({ title: text });
}

async function dateStep({ rt, show, text: typed, callback }: StepInput): Promise<void> {
  const wizardText = t(rt.lang).addWizard;
  const text = quickDateText(callback) ?? typed;
  if (!text) {
    await show(wizardText.unsupported);
    return;
  }
  const parsed = parseWizardDateTime(text, rt.timezone, rt.state.pendingDate);
  if (parsed.kind === 'needs_time') {
    await rt.update({ pendingDate: parsed.localDate, startAt: undefined }, { step: undefined });
    await show(wizardText.askTime(parsed.localDate));
  } else if (parsed.kind === 'complete') {
    await rt.update({ startAt: parsed.startAt, pendingDate: undefined, endAt: undefined });
  } else await show(parsed.kind === 'ambiguous_number' ? wizardText.ambiguousDate : wizardText.invalidDate);
}

async function durationStep({ rt, show, text, callback, skip }: StepInput): Promise<void> {
  const quick = /^add:duration:(30|60|120)$/.exec(callback)?.[1];
  const minutes = skip ? (rt.user.default_event_duration_minutes ?? 60) : parseDuration(quick ?? text ?? '');
  if (!rt.state.startAt) {
    await rt.goTo(1);
    return;
  }
  if (!minutes || !Number.isFinite(minutes) || minutes > 525600) {
    await show(t(rt.lang).addWizard.invalidDuration);
    return;
  }
  await rt.update({ endAt: applyDefaultDuration(rt.state.startAt, minutes) });
}

function customRecurrenceRule(text: string | undefined): string | undefined {
  const parsed = text ? parseRecurrence(text) : null;
  if (!parsed || parsed.interval < 1 || parsed.interval > 999) return undefined;
  return `FREQ=${parsed.freq}${parsed.interval === 1 ? '' : `;INTERVAL=${parsed.interval}`}`;
}

async function recurrenceStep({ rt, show, text, callback }: StepInput): Promise<void> {
  const value = /^ar:(none|DAILY|WEEKLY|MONTHLY|YEARLY|custom)$/.exec(callback)?.[1];
  if (value === 'none' || /^(?:нет|не повторять|без повторения|none|no|never)$/i.test(text ?? '')) {
    await rt.update({ recurrenceRule: null, recEndMode: undefined }, { step: 5 });
    return;
  }
  if (value === 'custom') {
    await show(t(rt.lang).recurrence_custom_prompt);
    return;
  }
  const rule = value ? `FREQ=${value}` : customRecurrenceRule(text);
  if (rule) await rt.update({ recurrenceRule: rule, recEndMode: undefined });
  else await show(t(rt.lang).addWizard.invalidRepeat);
}

async function applyRecurrenceCount(input: StepInput, rule: string, text: string): Promise<void> {
  const count = Number(/^(\d+)\s*(?:раз|повторений|повторения|повторение|times|repeats)?$/i.exec(text)?.[1] ?? 0);
  if (count < 1 || count > 999) {
    await input.show(t(input.rt.lang).addWizard.invalidCount);
    return;
  }
  await input.rt.update({ recurrenceRule: withRecurrenceEnd(rule, `COUNT=${count}`), recEndMode: undefined });
}

async function applyRecurrenceUntil(input: StepInput, rule: string, text: string): Promise<void> {
  const { rt, show } = input;
  const date = recurrenceUntilDate(text.replace(/^(?:до|until)\s+/i, ''), rt.timezone, rt.state.startAt);
  const endsBeforeStart =
    date !== null &&
    rt.state.startAt !== undefined &&
    endOfDay(new TZDate(date, rt.timezone)).getTime() < new Date(rt.state.startAt).getTime();
  if (!date || endsBeforeStart) {
    await show(t(rt.lang).addWizard.invalidEnd);
    return;
  }
  await rt.update({
    recurrenceRule: withRecurrenceEnd(rule, `UNTIL=${recurrenceUntilValue(date, rt.timezone)}`),
    recEndMode: undefined,
  });
}

async function applyRecurrenceEndValue(
  input: StepInput,
  rule: string,
  recEndMode: AddEventState['recEndMode'],
  text: string | undefined,
): Promise<void> {
  const wizardText = t(input.rt.lang).addWizard;
  if (!text) {
    await input.show(wizardText.unsupported);
    return;
  }
  const bareNumber = /^\d+$/.test(text);
  if (!recEndMode && bareNumber) {
    await input.show(wizardText.ambiguousEnd(text), text);
    return;
  }
  const writtenCount = /^(\d+)\s*(?:раз|повторений|повторения|повторение|times|repeats)?$/i.test(text) && !bareNumber;
  if (recEndMode === 'count' || (!recEndMode && writtenCount)) await applyRecurrenceCount(input, rule, text);
  else await applyRecurrenceUntil(input, rule, text);
}

async function recurrenceEndStep(input: StepInput): Promise<void> {
  const { rt, show, callback } = input;
  const rule = rt.state.recurrenceRule;
  if (!rule) {
    await rt.goTo(3);
    return;
  }
  const mode = /^are:(forever|until|count)(?::(\d{1,3}))?$/.exec(callback);
  if (mode?.[1] === 'forever' || /^(?:forever|no end|бесконечно|без конца|никогда)$/i.test(input.text ?? '')) {
    await rt.update({ recurrenceRule: stripRecurrenceEnd(rule), recEndMode: undefined });
    return;
  }
  const chosen = mode?.[1] === 'until' || mode?.[1] === 'count' ? mode[1] : undefined;
  if (!chosen) {
    await applyRecurrenceEndValue(input, rule, rt.state.recEndMode, input.text);
    return;
  }
  await rt.update({ recEndMode: chosen }, { step: undefined });
  if (mode?.[2]) await applyRecurrenceEndValue(input, rule, chosen, mode[2]);
  else await show(chosen === 'until' ? t(rt.lang).recurrence_until_prompt : t(rt.lang).recurrence_count_prompt);
}

async function optionalTextStep({ rt, show, text, skip }: StepInput): Promise<void> {
  if (!skip && !text) {
    await show(t(rt.lang).addWizard.unsupported);
    return;
  }
  if (rt.step === 5) await rt.update({ description: skip ? undefined : rt.message?.text });
  else await rt.update({ location: skip ? undefined : text });
}

function notifyEventCreated(deps: AddEventDeps, user: User, event: CalendarEvent): void {
  deps
    .onEventCreated?.(user.telegram_id, event.id)
    .catch((err) => cmdLogger.error({ err, eventId: event.id }, 'Event saved; post-create delivery failed'));
  if (event.location && deps.locationVerification) {
    deps.locationVerification
      .verifyEventLocation(event, user)
      .catch((err) => cmdLogger.error({ err, eventId: event.id }, 'Event saved; location verification failed'));
  }
}

async function persistDraft(rt: AddEventRuntime, deps: AddEventDeps, title: string, startAt: string): Promise<number> {
  const { state, user } = rt;
  if (state.createdEventId) return state.createdEventId;
  const { endAt, description, location, recurrenceRule } = state;
  const event = deps.eventService.createEvent({
    user_id: user.telegram_id,
    title,
    start_at: startAt,
    end_at: endAt,
    timezone: rt.timezone,
    description,
    location,
    recurrence_rule: recurrenceRule ?? undefined,
    ...(state.groupId ? { owner_type: 'group' as const, group_id: state.groupId, created_by: user.telegram_id } : {}),
  });
  await rt.update({ createdEventId: event.id }, { step: undefined });
  deps.actionLogRepo?.insert({
    user_id: user.telegram_id,
    chat_id: Number(rt.chatId ?? user.telegram_id),
    action_type: 'scene',
    action_name: 'create_event',
    input_summary: title,
    result_summary: `id: ${event.id}`,
    target_event_id: event.id,
    metadata: JSON.stringify({ startAt, endAt, recurrenceRule }),
  });
  notifyEventCreated(deps, user, event);
  return event.id;
}

function submitDraftOnce(rt: AddEventRuntime, deps: AddEventDeps, title: string, startAt: string): Promise<number> {
  const key = `${rt.user.telegram_id}:${rt.chatId}:${rt.state.promptMessageId}`;
  const existing = deps.submissions.get(key);
  if (existing) return existing;
  const saved = persistDraft(rt, deps, title, startAt);
  deps.submissions.set(key, saved);
  if (deps.submissions.size > MAX_TRACKED_SUBMISSIONS) {
    const oldest = deps.submissions.keys().next().value;
    if (oldest) deps.submissions.delete(oldest);
  }
  return saved;
}

async function sendReceipt(rt: AddEventRuntime, id: number, title: string, event: CalendarEvent): Promise<void> {
  const receipt = splitMessage(
    `${t(rt.lang).event_created(escapeHtml(title))}\n\n${formatEventDetail(event, rt.timezone, rt.lang)}`,
    4000,
    'HTML',
  );
  for (const [index, chunk] of receipt.entries()) {
    await rt.send(chunk, {
      parse_mode: 'HTML',
      ...(index === receipt.length - 1 ? { reply_markup: eventActionsKeyboard(id, rt.lang) } : {}),
    });
  }
}

async function confirmStep(input: StepInput, deps: AddEventDeps): Promise<void> {
  const { rt, show, callback } = input;
  const wizardText = t(rt.lang).addWizard;
  if (callback !== 'add:confirm') {
    await show(draftPreview(rt.state, rt.lang, rt.timezone), undefined, true);
    return;
  }
  const { title, startAt } = rt.state;
  if (!title || !startAt) {
    await show(wizardText.missing);
    return;
  }
  const saved = submitDraftOnce(rt, deps, title, startAt);
  try {
    const id = await saved;
    await rt.exit();
    const event = deps.eventService.getEvent(id, rt.user.telegram_id);
    if (!event) {
      await rt.send(wizardText.saveFailed);
      return;
    }
    await sendReceipt(rt, id, title, event);
  } catch (err) {
    cmdLogger.error({ err, userId: rt.user.telegram_id }, 'Add-event save or receipt failed');
    await rt.send(wizardText.saveFailed);
  }
}

function dispatchStep(input: StepInput, deps: AddEventDeps): Promise<void> {
  switch (input.rt.step) {
    case 0:
      return titleStep(input);
    case 1:
      return dateStep(input);
    case 2:
      return durationStep(input);
    case 3:
      return recurrenceStep(input);
    case 4:
      return recurrenceEndStep(input);
    case 5:
    case 6:
      return optionalTextStep(input);
    default:
      return confirmStep(input, deps);
  }
}

export async function runAddEventStep(rt: AddEventRuntime, deps: AddEventDeps): Promise<void> {
  const show = createShow(rt);
  if (rt.firstTime) {
    await promptStep(rt, show);
    return;
  }
  if (rt.callback && (await handleCallbackControl(rt, rt.callback))) return;
  const text = rt.message?.text?.trim();
  const callback = rt.callback?.data ?? '';
  const skip = callback === `${CB.ADD_SKIP}:${rt.step}` || (text !== undefined && /^(?:skip|пропустить)$/i.test(text));
  await dispatchStep({ rt, show, text, callback, skip }, deps);
}
