/**
 * Run-local mutation evidence. It decides whether the model's own text may stand (a failed,
 * skipped, unconfirmed or undelivered write means it may not) and supplies the receipt that
 * replaces it (see write-receipt.ts). Receipts describe this run's attempts, not durable intent.
 */

import { EVENT_UPDATE_FIELDS, UNRESOLVED_PLACE } from '../../database/repositories/event.repository.ts';
import { allDayCalendarDate } from '../../utils/date.ts';
import { eventTimestampSchema } from '../../utils/event-timestamps.ts';
import { extractEventSummaries } from './event-summaries.ts';
import { normalizeNumericId } from './numeric-id.ts';
import { normalizeRecipientUsername } from './recipient-identity.ts';
import { DELIVERING_TOOLS, type ExecutorDisposition, isMutationTool, SILENT_TOOLS } from './tool-executor.ts';
import { resolveScope } from './tool-handlers/shared.ts';
import type { ToolResult } from './types.ts';
import {
  type CreateDetails,
  type CreateKeyParts,
  type CreateKeys,
  type EventRef,
  type Invitee,
  type KnownEvent,
  type ReceiptView,
  renderReceipt,
  type Timing,
  type WriteOutcome,
} from './write-receipt.ts';

const targets = {
  delete_event: ['event_id', 'scope', 'owner_id'],
  update_event: ['event_id', 'scope', 'owner_id'],
  // No owner_id: event ids are global, so a retry that adds the calendar owner is the same invitation.
  send_invitation: ['event_id', 'invitee_id', 'invitee_username'],
} satisfies { [operation: string]: string[] };
/** Fields update_event can change; the confirmed place is set only by the creator's tap or pin (#620). */
const updateFields = [...EVENT_UPDATE_FIELDS, 'location_abstract'].filter(
  (field) => !Object.hasOwn(UNRESOLVED_PLACE, field),
);
function isTargetOperation(operation: string): operation is keyof typeof targets {
  return Object.hasOwn(targets, operation);
}
function positiveId(value: unknown): number | null {
  const id = normalizeNumericId(value);
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * What makes two calls the same write: the target fields of a target operation, normalized so an id sent
 * as "7" and as 7 collide, and an invitee is the person inviteeOf reads ("bob", "@bob" and " Bob" are one).
 * Any other write is distinct per attempt.
 */
function attemptIdentity(operation: string, fields: object, attempt: number): number | unknown[] {
  if (!isTargetOperation(operation)) return attempt;
  if (operation === 'send_invitation') {
    const who = inviteeOf(fields);
    const target = who
      ? (who.id ?? `@${who.username}`)
      : [Reflect.get(fields, 'invitee_id'), Reflect.get(fields, 'invitee_username')];
    return [normalizeNumericId(Reflect.get(fields, 'event_id')), target];
  }
  return targets[operation].map((field) => {
    const value: unknown = Reflect.get(fields, field);
    return [field, field.endsWith('_id') ? normalizeNumericId(value) : value];
  });
}
/** update_event is judged field by field; the fields the call actually set. */
function requestedUpdateFields(operation: string, fields: object): string[] {
  if (operation !== 'update_event') return [];
  return updateFields.filter((field) => Reflect.get(fields, field) !== undefined);
}

/** Who a send_invitation call named: the numeric id wins over a username, as in the identity. */
function inviteeOf(fields: object): Invitee | null {
  const id = positiveId(Reflect.get(fields, 'invitee_id'));
  if (id !== null) return { id, username: null };
  const username: unknown = Reflect.get(fields, 'invitee_username');
  const name = typeof username === 'string' ? normalizeRecipientUsername(username) : '';
  return /^\w{1,64}$/.test(name) ? { id: null, username: name } : null;
}

/** The event a create asked for, from its own input (a failed create returns no event). create_event stores the flag as sent. */
function requestedEvent(fields: object): EventRef | null {
  const title: unknown = Reflect.get(fields, 'title');
  if (typeof title !== 'string' || !title.trim()) return null;
  const start: unknown = Reflect.get(fields, 'start_at');
  return {
    title: title.trim(),
    startAt: typeof start === 'string' ? start : null,
    allDay: isTrue(Reflect.get(fields, 'all_day')),
  };
}

/**
 * When a successful write put its event: the start its own input carried, nothing else. A create is told
 * by the request itself (requestedEvent); an update that restated its start is told by that start, with the
 * all-day flag from its input or its confirmed result. Every other write (a delete, a snooze, an update
 * without a start) says nothing about the day and time, so its line names the event by title alone.
 */
function timingOf(operation: string, fields: object, result: ToolResult): Timing | null {
  const start: unknown = Reflect.get(fields, 'start_at');
  if (operation !== 'update_event' || typeof start !== 'string') return null;
  const flag: unknown = Reflect.get(fields, 'all_day');
  const allDay =
    extractEventSummaries(result.data)?.[0]?.all_day ?? (flag === undefined || flag === null ? null : isTrue(flag));
  // Whether the start is a day or an instant is unknown without a flag or a summary: name the event by title alone.
  return allDay === null ? null : { startAt: start, allDay };
}

/** The executor accepts the JSON strings "true"/"false" for a boolean; the ledger reads them the same way. */
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Reduces an RRULE line to what carries its meaning (RFC 5545 §3.3.10): the part order, the list
 * order inside a part, case, spacing, the `RRULE:` prefix and an INTERVAL that only restates the
 * default of 1 do not. Other lines of a stored rule (EXDATE, RDATE) are kept as written, uppercased.
 */
function canonicalRuleLine(line: string): string {
  const body = line.startsWith('RRULE:') ? line.slice('RRULE:'.length) : line;
  if (!/^[A-Z]+=/.test(body)) return line;
  return body
    .split(';')
    .filter((part) => part !== '' && part !== 'INTERVAL=1')
    .map((part) => {
      const [name = '', ...value] = part.split('=');
      return `${name}=${value.join('=').split(',').sort().join(',')}`;
    })
    .sort()
    .join(';');
}

/** The recurrence of a create request in a form equal for equal series, or null for a one-off event. */
function canonicalRecurrence(rule: unknown): string | null {
  if (typeof rule !== 'string') return null;
  const lines = rule
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ''))
    .filter((line) => line !== '')
    .map(canonicalRuleLine)
    .sort();
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * What a create's start or end identifies. A one-off all-day value (`byDay`) is its calendar day as the
 * bot itself reads it (the date-only form, T00:00:00Z and the user's local midnight in UTC are one day);
 * any other value is its instant (a series expands from its start instant, so its spellings stay
 * distinct), and anything that does not parse stays as written. Absent or blank is null.
 */
function momentKey(value: unknown, byDay: boolean, timezone: string): number | string | null {
  const text = optionalText(value);
  if (text === null) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || !eventTimestampSchema.safeParse(text).success) return text;
  return byDay ? (calendarDayOf(text, timezone) ?? ms) : ms;
}

/**
 * The same requested event up to case and spacing of the title, the start instant, the calendar
 * (owner and personal/group scope) and its recurrence: a failed group or recurring create is not
 * the one-off personal event that later succeeded, so that success must not fold it away. An
 * omitted scope means what the chat makes of it, as in the create handler. The end, location and
 * description are kept apart: a later success of the event replaces an earlier failure whichever
 * of them the corrected retry changed, but a later failure is hidden behind an earlier success only
 * when it asked for the same details.
 */
function createKeysOf(
  ref: EventRef | null,
  owner: number | null,
  fields: object,
  isGroup: boolean,
  timezone: string,
): CreateKeys | null {
  if (!ref) return null;
  const scope: unknown = Reflect.get(fields, 'scope');
  const recurrence = canonicalRecurrence(Reflect.get(fields, 'recurrence_rule'));
  const byDay = ref.allDay && recurrence === null;
  const parts: CreateKeyParts = {
    title: titleKey(ref.title),
    start: momentKey(ref.startAt, byDay, timezone),
    allDay: ref.allDay,
    owner,
    scope: resolveScope({ scope: typeof scope === 'string' ? scope : undefined }, { isGroup }),
    recurrence,
  };
  const details: CreateDetails = {
    end: momentKey(Reflect.get(fields, 'end_at'), byDay, timezone),
    location: optionalText(Reflect.get(fields, 'location')),
    description: optionalText(Reflect.get(fields, 'description')),
  };
  return serializeKeys(parts, details);
}

/** A create's keys: the fields kept by name, and the strings they are compared by, built from a fixed order. */
function serializeKeys(parts: CreateKeyParts, details: CreateDetails): CreateKeys {
  const { title, start, allDay, owner, scope, recurrence } = parts;
  return {
    parts,
    details,
    key: JSON.stringify([title, start, allDay, owner, scope, recurrence]),
    detailsKey: JSON.stringify([details.end, details.location, details.description]),
  };
}

/** Free text as the ledger compares it: trimmed, and empty means absent. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A title as the create key compares it: spacing and case do not tell two requests apart. */
function titleKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * The end a create stands for after an update: restated, kept while its form is unchanged, or unknown
 * (undefined). A moved start does not move a stored end: update_event writes only the fields it is given.
 */
function endAfterUpdate(
  kept: number | string | null,
  restated: unknown,
  keptKind: boolean,
  byDay: boolean,
  timezone: string,
): number | string | null | undefined {
  if (restated !== undefined) return momentKey(restated, byDay, timezone);
  return keptKind || kept === null ? kept : undefined;
}

/**
 * What a create stands for once an update has changed the event: the update's own title, start, end,
 * location, description, all-day flag and recurrence replace the create's. Null when the event can no
 * longer be keyed: a start or end is keyed by its calendar day for a one-off all-day event and by its
 * instant otherwise, so when an update flips that form without restating the value, the remembered one
 * cannot be re-read in the other form. A title and all-day flag the confirmed result carries win over the input.
 */
function keysAfterUpdate(
  keys: CreateKeys,
  fields: object,
  confirmed: { title: string; all_day: boolean } | undefined,
  timezone: string,
): CreateKeys | null {
  const { parts: before, details } = keys;
  const newTitle: unknown = confirmed?.title ?? Reflect.get(fields, 'title');
  const newAllDay: unknown = confirmed?.all_day ?? Reflect.get(fields, 'all_day');
  const newRule: unknown = Reflect.get(fields, 'recurrence_rule');
  const newStart: unknown = Reflect.get(fields, 'start_at');
  const newEnd: unknown = Reflect.get(fields, 'end_at');
  const allDay = newAllDay === undefined ? before.allDay : isTrue(newAllDay);
  const recurrence = newRule === undefined ? before.recurrence : canonicalRecurrence(newRule);
  const byDay = allDay && recurrence === null;
  const keptKind = byDay === (before.allDay && before.recurrence === null);
  const start =
    typeof newStart === 'string' ? momentKey(newStart, byDay, timezone) : keptKind ? before.start : undefined;
  const end = endAfterUpdate(details.end, newEnd, keptKind, byDay, timezone);
  if (start === undefined || end === undefined) return null;
  const location: unknown = Reflect.get(fields, 'location');
  const description: unknown = Reflect.get(fields, 'description');
  const parts: CreateKeyParts = {
    ...before,
    title: typeof newTitle === 'string' ? titleKey(newTitle) : before.title,
    start,
    allDay,
    recurrence,
  };
  const asked: CreateDetails = {
    end,
    location: location === undefined ? details.location : optionalText(location),
    description: description === undefined ? details.description : optionalText(description),
  };
  return serializeKeys(parts, asked);
}

/** The calendar day a written all-day start stands for in the user's zone, or null when it cannot be read. */
function calendarDayOf(start: string, timezone: string): string | null {
  try {
    return allDayCalendarDate(start, timezone);
  } catch {
    return null;
  }
}

/** A recorded create of this event that still has keys to fold a later attempt into. */
function isCreateOf(outcome: WriteOutcome, eventId: number): outcome is WriteOutcome & { create: CreateKeys } {
  return outcome.operation === 'create_event' && outcome.eventId === eventId && outcome.create !== null;
}

/** Whether `repeat` is the same failure as `told`: a create with the same details that ended the same way (skipped, refused or unknown). */
function repeatsFailure(told: WriteOutcome, repeat: WriteOutcome): boolean {
  const standing = (o: WriteOutcome) =>
    o.disposition === 'skipped' ? 'skipped' : endedUnknown(o) ? 'unknown' : 'refused';
  return !told.success && told.create?.detailsKey === repeat.create?.detailsKey && standing(told) === standing(repeat);
}

/** Whether an invitation write succeeded and reached the person (not merely created, or failed). */
function reached(outcome: WriteOutcome): boolean {
  return outcome.success && !(outcome.effect?.kind === 'invitation' && outcome.effect.delivery !== 'delivered');
}

/** A write that failed and may still have happened, or whose result was never known. */
function endedUnknown(outcome: WriteOutcome): boolean {
  return !outcome.success && outcome.disposition !== 'skipped' && outcome.mutationState !== 'not_applied';
}

export class WriteOutcomes {
  private readonly outcomes = new Map<string, WriteOutcome>();
  /** Every event this run's successful results carried, so a later write can be named by its title and calendar. */
  private readonly events = new Map<number, KnownEvent>();
  private attempts = 0;
  mayHaveMutated = false;
  /** A rendered image reached the chat. */
  private delivered = false;
  /** A render was asked for but sent nothing: it failed, or the throttle skipped it. */
  private deliveryMissed = false;
  /** A silent answering tool (a reaction) reached the chat. */
  private reacted = false;
  speechQuestion = '';

  /**
   * The request was answered by a tool, so a silent final is fine: a picture arrived, or the
   * turn only reacted. A 👍 does not stand in for a picture that was asked for and never came.
   */
  get toolAnswered(): boolean {
    return this.delivered || (this.reacted && !this.deliveryMissed);
  }

  constructor(private readonly writes: ReadonlySet<string> = new Set(Object.keys(targets))) {}

  /** `isGroup`: whether the chat is a group, which decides the scope of a create that names none. */
  record(
    operation: string,
    input: unknown,
    result: ToolResult & { disposition: ExecutorDisposition },
    isGroup = false,
    timezone = 'UTC',
  ): void {
    const fields = typeof input === 'object' && input !== null ? input : {};
    const isWrite = this.writes.has(operation) && isMutationTool(operation, input);
    this.noteTurnEffects(operation, result);
    this.noteEvents(fields, result);
    if (!isWrite || result.disposition === 'waiting') return;
    const success = result.disposition === 'executed' && result.success;
    const owner = positiveId(Reflect.get(fields, 'owner_id'));
    const requested = operation === 'create_event' ? requestedEvent(fields) : null;
    const attempt = ++this.attempts;
    const identity = attemptIdentity(operation, fields, attempt);
    const outcome: WriteOutcome = {
      operation,
      eventId: this.eventIdOf(operation, fields, result, success),
      requested,
      timing: success ? timingOf(operation, fields, result) : null,
      owner,
      invitee: operation === 'send_invitation' ? inviteeOf(fields) : null,
      success,
      disposition: result.disposition,
      mutationState: result.mutationState,
      effect: result.effect,
      unknownRetried: false,
      repeatUnknown: [],
      create: createKeysOf(requested, owner, fields, isGroup, timezone),
    };
    const unknown = endedUnknown(outcome);
    if (success || unknown) this.updateCreatesOfEvent(operation, fields, result, outcome.eventId, timezone, unknown);
    if (this.foldCreateAttempt(outcome)) return;
    this.storeByField(outcome, identity, requestedUpdateFields(operation, fields));
  }

  /**
   * A create whose event was deleted or snoozed no longer stands for that event, and neither does one
   * whose update result is unknown and may have changed it: a later failed create of the same request
   * is a new attempt and must stay visible, not be folded into it. A successful update rewrites what the
   * create stands for (see keysAfterUpdate), so a later failure that asks for exactly what the event now
   * is stays folded, and a rejected earlier one that asked for it is settled.
   */
  private updateCreatesOfEvent(
    operation: string,
    fields: object,
    result: ToolResult,
    eventId: number | null,
    timezone: string,
    unknown: boolean,
  ): void {
    if (eventId === null) return;
    const deleted = operation === 'delete_event' && (result.effect?.kind === 'event_deleted' || unknown);
    const moved = operation === 'snooze_event';
    if (!deleted && !moved && operation !== 'update_event') return;
    const confirmed = extractEventSummaries(result.data)?.find((event) => event.id === eventId);
    for (const outcome of this.outcomes.values()) {
      if (!isCreateOf(outcome, eventId)) continue;
      const after = deleted || moved ? null : keysAfterUpdate(outcome.create, fields, confirmed, timezone);
      this.reconcileCreate(outcome, outcome.create, after, unknown);
    }
  }

  /** Sets what a create stands for after a write to its event; an unknown result can only retire it, never rewrite it. */
  private reconcileCreate(outcome: WriteOutcome, before: CreateKeys, after: CreateKeys | null, unknown: boolean): void {
    if (unknown) {
      const changed = after === null || after.key !== before.key || after.detailsKey !== before.detailsKey;
      if (changed) outcome.create = null;
      return;
    }
    outcome.create = after;
    if (after !== null) this.settleRejectedCreates(after);
  }

  /** A create that was refused and asked for exactly what an event now is no longer needs telling. */
  private settleRejectedCreates({ key, detailsKey }: CreateKeys): void {
    for (const [id, outcome] of this.outcomes) {
      const refused = !outcome.success && !endedUnknown(outcome);
      if (refused && outcome.create?.key === key && outcome.create.detailsKey === detailsKey) this.outcomes.delete(id);
    }
  }

  /** Keeps the outcome once per written field; a skipped repeat of a recorded write adds nothing. */
  private storeByField(outcome: WriteOutcome, identity: number | unknown[], requestedFields: string[]): void {
    if (outcome.operation === 'send_invitation') {
      this.storeInvitation(outcome, identity);
      return;
    }
    for (const field of requestedFields.length ? requestedFields : [undefined]) {
      const key = JSON.stringify([outcome.operation, identity, field]);
      if (outcome.disposition === 'skipped' && this.outcomes.has(key)) continue;
      this.outcomes.set(key, { ...outcome, field });
    }
  }

  /**
   * An invitation to one person keeps two places: what was delivered, and the latest failure. A later failure
   * never erases a delivery, and a refusal never erases an attempt that may have gone through; a delivery clears
   * the failure it follows (an unknown one leaves the duplicate warning).
   */
  private storeInvitation(outcome: WriteOutcome, identity: number | unknown[]): void {
    const deliveredKey = JSON.stringify([outcome.operation, identity, 'delivered']);
    const failedKey = JSON.stringify([outcome.operation, identity, 'failed']);
    const delivered = this.outcomes.get(deliveredKey);
    const failed = this.outcomes.get(failedKey);
    if (outcome.disposition === 'skipped' && (delivered || failed)) return;
    // The attempt that may have gone through before this one makes this one a possible duplicate.
    const priorUnknown = failed !== undefined && (endedUnknown(failed) || failed.unknownRetried);
    // A success that did not reach the person is told beside a delivery, never over it.
    const overDelivery = delivered !== undefined && reached(delivered) && !reached(outcome);
    if (outcome.success && !overDelivery) {
      this.outcomes.delete(failedKey);
      this.outcomes.set(deliveredKey, {
        ...outcome,
        unknownRetried: outcome.unknownRetried || delivered?.unknownRetried === true || priorUnknown,
      });
      return;
    }
    // Only a refusal yields to what is stored: an attempt that may have gone through, or created an invitation.
    const refusal = !outcome.success && !endedUnknown(outcome);
    if (failed && refusal && (failed.success || endedUnknown(failed))) return;
    this.outcomes.set(failedKey, {
      ...outcome,
      unknownRetried: outcome.unknownRetried || (outcome.success && priorUnknown),
    });
  }

  /** The id of the event a successful create returned. */
  private createdEventId(operation: string, result: ToolResult): number | null {
    return operation === 'create_event' ? (extractEventSummaries(result.data)?.[0]?.id ?? null) : null;
  }

  /**
   * A create has no target to match a retry by, so the same requested event decides. A later
   * success replaces the failures of that event (an unknown one leaves a duplicate warning); a later
   * failed or skipped try at an event that already exists, asking for the same details, adds nothing,
   * unless its result is unknown, when the existing one may now be there twice (a separate warning:
   * here the repeat is the unknown one). Returns true when the attempt is folded away.
   */
  private foldCreateAttempt(attempt: WriteOutcome): boolean {
    if (attempt.create === null) return false;
    const { key, detailsKey } = attempt.create;
    const same = [...this.outcomes].filter(([, outcome]) => outcome.create?.key === key);
    if (!attempt.success) {
      const settled = same.find(([, outcome]) => outcome.success && outcome.create?.detailsKey === detailsKey)?.[1];
      // Next to a success that asked for other details, an identical failure already told is not told again.
      if (!settled) {
        return same.some(([, o]) => o.success) && same.some(([, outcome]) => repeatsFailure(outcome, attempt));
      }
      if (endedUnknown(attempt) && attempt.requested)
        settled.repeatUnknown = [...settled.repeatUnknown, attempt.requested];
      return true;
    }
    for (const [id, earlier] of same) {
      if (earlier.success) continue;
      this.outcomes.delete(id);
      if (endedUnknown(earlier)) attempt.unknownRetried = true;
    }
    return false;
  }

  /** Run-wide flags a tool result sets whether or not it is a recorded write: speech question, mutation, delivery. */
  private noteTurnEffects(operation: string, result: ToolResult & { disposition: ExecutorDisposition }): void {
    if (result.awaitingInput?.kind === 'speech') this.speechQuestion = result.awaitingInput.question;
    if (result.mutationState === 'confirmed' || result.mutationState === 'uncertain') this.mayHaveMutated = true;
    const sent = result.disposition === 'executed' && result.success;
    if (DELIVERING_TOOLS.has(operation)) {
      if (sent) this.delivered = true;
      else this.deliveryMissed = true;
    } else if (SILENT_TOOLS.has(operation) && sent) this.reacted = true;
  }

  /** A create is named by the event it returned: an extra event_id in its input is not that event. */
  private eventIdOf(operation: string, fields: object, result: ToolResult, success: boolean): number | null {
    if (operation !== 'create_event') return positiveId(Reflect.get(fields, 'event_id'));
    return success ? this.createdEventId(operation, result) : null;
  }

  /**
   * Remembers the title and calendar of every event a successful result carried, read or written, so a
   * later write can be named. Never a day or time: those come only from a write's own input (see timingOf),
   * because a read lists occurrences, first starts and shifted all-day dates that are not what a write did.
   */
  private noteEvents(input: object, result: ToolResult & { disposition: ExecutorDisposition }): void {
    if (result.disposition !== 'executed' || !result.success) return;
    const named = positiveId(Reflect.get(input, 'owner_id'));
    for (const event of extractEventSummaries(result.data) ?? []) {
      this.events.set(event.id, { title: event.title, owner: named ?? this.events.get(event.id)?.owner ?? null });
    }
  }

  /**
   * The receipt that replaces the model's text, or null when its text may stand: nothing failed,
   * was skipped, left unconfirmed, declined or went undelivered. A failure a later write of the
   * same target fixed is no longer in the ledger.
   */
  finalNotice(view: ReceiptView, interrupted = false): string | null {
    const needsGuard = [...this.outcomes.values()].some(
      (outcome) =>
        !outcome.success ||
        outcome.unknownRetried ||
        outcome.repeatUnknown.length > 0 ||
        outcome.effect?.kind === 'attendance_declined' ||
        (outcome.effect?.kind === 'invitation' && outcome.effect.delivery !== 'delivered'),
    );
    if (!interrupted && !needsGuard) return null;
    return renderReceipt([...this.outcomes.values()], this.events, view, interrupted);
  }

  /** Every recorded write, clean successes included — for a turn the model left without an answer. */
  summary(view: ReceiptView): string | null {
    return renderReceipt([...this.outcomes.values()], this.events, view, false);
  }
}
