// src/services/ai/delete-confirmation.ts
// Deletes need a tap on a list the bot rendered itself: the model's own wording never approves one.

import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { enUS, ru } from 'date-fns/locale';
import { InlineKeyboard } from 'gramio';
import { type Lang, t } from '../../config/constants.ts';
import type { CalendarEvent } from '../../database/types.ts';

/** One event on a delete confirmation, with what the delete call needs to reach it. */
export interface DeleteTarget {
  eventId: number;
  scope: 'personal' | 'group';
  /** Set when a secretary deletes from the owner's calendar. */
  ownerId?: number;
  title: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  recurring: boolean;
  /** Already over when the confirmation was built; only the explicit "including past" choice deletes it. */
  past: boolean;
}

/** `upcoming` keeps past events; `all` is the explicit "including past" button. */
export type DeleteChoice = 'upcoming' | 'all';

interface PendingConfirmation {
  actorId: number;
  chatId: number;
  targets: DeleteTarget[];
  expiresAt: number;
}

const PENDING_TTL_MS = 30 * 60_000;
const APPROVAL_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 1000;
const pending = new Map<string, PendingConfirmation>();
/** Key `${actorId}:${chatId}:${eventId}` → expiry. */
const approvals = new Map<string, number>();

function evictExpired<V>(map: Map<string, V>, expiresAt: (value: V) => number, now: number): void {
  for (const [key, value] of map) if (expiresAt(value) <= now) map.delete(key);
  while (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** A series keeps producing occurrences, so it is never "past" as a whole. */
export function isPastEvent(
  event: Pick<CalendarEvent, 'start_at' | 'end_at' | 'recurrence_rule'>,
  now: number,
): boolean {
  if (event.recurrence_rule) return false;
  return Date.parse(event.end_at ?? event.start_at) <= now;
}

export function issueDeleteConfirmation(
  actorId: number,
  chatId: number,
  targets: DeleteTarget[],
  now = Date.now(),
): string {
  evictExpired(pending, (p) => p.expiresAt, now);
  const token = crypto.randomUUID();
  pending.set(token, { actorId, chatId, targets, expiresAt: now + PENDING_TTL_MS });
  return token;
}

export function dropDeleteConfirmation(token: string): void {
  pending.delete(token);
}

/**
 * Single use, and only for the user who asked in the chat where it was asked. A tap by
 * anyone else leaves the confirmation in place for its owner.
 */
export function takeDeleteConfirmation(
  token: string,
  actorId: number,
  chatId: number,
  now = Date.now(),
): DeleteTarget[] | null {
  const item = pending.get(token);
  if (!item || item.actorId !== actorId || item.chatId !== chatId) return null;
  pending.delete(token);
  if (item.expiresAt <= now) return null;
  return item.targets;
}

export function chooseTargets(targets: DeleteTarget[], choice: DeleteChoice): DeleteTarget[] {
  return choice === 'all' ? targets : targets.filter((target) => !target.past);
}

export function approveDeletes(actorId: number, chatId: number, eventIds: number[], now = Date.now()): void {
  evictExpired(approvals, (expiresAt) => expiresAt, now);
  for (const eventId of eventIds) approvals.set(`${actorId}:${chatId}:${eventId}`, now + APPROVAL_TTL_MS);
}

/** True once per approved event; an expired or foreign approval is refused. */
export function consumeDeleteApproval(actorId: number, chatId: number, eventId: number, now = Date.now()): boolean {
  const key = `${actorId}:${chatId}:${eventId}`;
  const expiresAt = approvals.get(key);
  if (expiresAt === undefined) return false;
  approvals.delete(key);
  return expiresAt > now;
}

/** "вт, 29 сентября, 12:30–13:30" in the user's current zone; the year only when it is not this year's. */
export function formatTargetWhen(target: DeleteTarget, timezone: string, lang: Lang, now: number): string {
  const locale = lang === 'ru' ? ru : enUS;
  const start = new TZDate(target.startAt, timezone);
  const sameYear = start.getFullYear() === new TZDate(now, timezone).getFullYear();
  const day = format(
    start,
    lang === 'ru' ? `EEEEEE, d MMMM${sameYear ? '' : ' yyyy'}` : `EEE, d MMM${sameYear ? '' : ' yyyy'}`,
    {
      locale,
    },
  );
  if (target.allDay) return day;
  const from = format(start, 'HH:mm');
  return target.endAt ? `${day}, ${from}–${format(new TZDate(target.endAt, timezone), 'HH:mm')}` : `${day}, ${from}`;
}

/** The list the user confirms: every event with its local weekday, date and time, past ones marked. */
export function renderDeleteConfirmation(targets: DeleteTarget[], timezone: string, lang: Lang, now: number): string {
  const tr = t(lang).aiTools.meta;
  const lines = targets.map((target) => {
    const marks = [target.past ? tr.deletePastMark : null, target.recurring ? tr.deleteRecurringMark : null].filter(
      (mark) => mark !== null,
    );
    const suffix = marks.length > 0 ? ` · ${marks.join(', ')}` : '';
    return `• «${target.title}» — ${formatTargetWhen(target, timezone, lang, now)}${suffix}`;
  });
  const pastCount = targets.filter((target) => target.past).length;
  const note = pastCount > 0 ? `\n\n${tr.deleteConfirmPastNote(pastCount)}` : '';
  return `${tr.deleteConfirmHeader(targets.length)}\n${lines.join('\n')}${note}`;
}

/** Callback data `dlc:<token>:<u|a|x>`: upcoming only, all including past, cancel. */
export function deleteConfirmationKeyboard(token: string, targets: DeleteTarget[], lang: Lang): InlineKeyboard {
  const tr = t(lang).aiTools.meta;
  const upcoming = targets.filter((target) => !target.past).length;
  const keyboard = new InlineKeyboard();
  if (upcoming === targets.length) {
    keyboard.text(tr.deleteButton(upcoming), `dlc:${token}:u`).row();
  } else {
    if (upcoming > 0) keyboard.text(tr.deleteUpcomingOnlyButton(upcoming), `dlc:${token}:u`).row();
    const all = upcoming > 0 ? tr.deleteIncludingPastButton(targets.length) : tr.deletePastButton(targets.length);
    keyboard.text(all, `dlc:${token}:a`).row();
  }
  return keyboard.text(tr.deleteCancelButton, `dlc:${token}:x`);
}

/**
 * The turn the AI gets after a tap. The deletes are already done, so it must report them, not
 * repeat them; the local date of the first upcoming deleted event is the day to picture.
 */
export function deleteReportForAgent(
  outcome: { deleted: DeleteTarget[]; kept: DeleteTarget[]; failed: DeleteTarget[] },
  timezone: string,
): string {
  const describe = (targets: DeleteTarget[]): string =>
    targets.length === 0
      ? 'none'
      : targets
          .map(
            (target) =>
              `#${target.eventId} «${target.title}» (${format(new TZDate(target.startAt, timezone), 'yyyy-MM-dd HH:mm')} local)`,
          )
          .join('; ');
  const upcoming = outcome.deleted.find((target) => !target.past);
  const day = upcoming ? format(new TZDate(upcoming.startAt, timezone), 'yyyy-MM-dd') : null;
  return [
    '[Delete confirmation] The user tapped the bot’s delete list. The bot already did the deletes:',
    `Deleted: ${describe(outcome.deleted)}.`,
    `Kept (past, not chosen): ${describe(outcome.kept)}.`,
    `Failed: ${describe(outcome.failed)}.`,
    'Do not call delete_event for these events. Tell the user the result briefly.',
    day ? `If you show a picture, show ${day}.` : 'Do not show a picture of a past day.',
  ].join('\n');
}
