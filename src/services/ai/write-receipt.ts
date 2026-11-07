/**
 * The receipt shown instead of the model's own text when a run had failed, skipped or unconfirmed
 * writes. It reads like an answer, not a ledger: what was done and to which event (title, local
 * time, whose calendar), what was not, for whom, and the one safe next step.
 *
 * Invariants:
 * - No raw ids, attempt counters or internal wording; an event or person that cannot be named is
 *   counted ("3 people"), never shown by id.
 * - Group chats hide every target: no title, time, calendar or name.
 * - A person is named only when the requester may see that name (their own contact, themselves, or
 *   the @username they typed); an id the model supplied never resolves to someone else's profile.
 * - An unknown result is told apart from a rejection: after a rejection nothing changed, after an
 *   unknown result the calendar has to be checked before anything is repeated.
 */
import { TZDate } from '@date-fns/tz';
import { type Messages, t, toLang } from '../../config/constants.ts';
import { allDayCalendarDate, describeCalendarDay } from '../../utils/date.ts';
import { eventTimestampSchema } from '../../utils/event-timestamps.ts';
import { localToday } from './day-references.ts';
import { DAY_MS, relativeDayWord } from './empty-agenda.ts';
import type { AgentContext, ToolResult } from './types.ts';

/** When a write put its event: the raw start its own input carried (never a read), and whether it is all-day. */
export interface Timing {
  startAt: string | null;
  allDay: boolean;
}
/** The event a write was about, by title and the timing that write itself carried. */
export interface EventRef extends Timing {
  title: string;
}
/** An event the run has seen (in a read or a write), by title and the calendar a call named for it. */
export interface KnownEvent {
  title: string;
  owner: number | null;
}
export interface Invitee {
  id: number | null;
  username: string | null;
}
export interface WriteOutcome {
  operation: string;
  eventId: number | null;
  /** What a create asked for: a failed create returns no event. */
  requested: EventRef | null;
  /** When a successful update that restated its start put the event; null for every other write. */
  timing: Timing | null;
  /** The calendar owner the call named (`owner_id`), when it named one. */
  owner: number | null;
  invitee: Invitee | null;
  field?: string;
  success: boolean;
  disposition: 'executed' | 'failed' | 'skipped' | 'waiting';
  mutationState?: ToolResult['mutationState'];
  effect?: ToolResult['effect'];
  /** A create that wrote nothing because the calendar already held that event: the same event, not a second creation. */
  alreadyExists?: ToolResult['alreadyExists'];
  /** An earlier try at this same write ended unknown: this success may have been written twice. */
  unknownRetried: boolean;
  /** Later repeats of this successful create that ended unknown (what each asked for): the event may now exist twice. */
  repeatUnknown: readonly EventRef[];
  /** For a create: the event's identity (normalized title, start, calendar, recurrence) and the details it asked for. Null for any other write. */
  create: CreateKeys | null;
}

/** What identifies a create, by name. */
export interface CreateKeyParts {
  title: string;
  start: number | string | null;
  allDay: boolean;
  owner: number | null;
  scope: string;
  recurrence: string | null;
}

/**
 * What else a create asked for; a later success of the same event settles a failure whatever these were.
 * Reminders and the location type (`location_abstract`) are deliberately not compared (tracked in #922).
 */
export interface CreateDetails {
  end: number | string | null;
  location: string | null;
  description: string | null;
}

/** A create as the ledger keys it: the identity of the event and the details it asked for, and the strings they are compared by. */
export interface CreateKeys {
  parts: CreateKeyParts;
  details: CreateDetails;
  key: string;
  detailsKey: string;
}

/**
 * The create fields (recurrence, all-day, end, location, description) a refused or unconfirmed create
 * asked for differently from a success of the same title and start, by field name, so its line cannot read
 * as a contradiction of the success. Told against the closest such success: the one differing in the fewest.
 */
function differingFields(outcome: WriteOutcome, outcomes: readonly WriteOutcome[]): string[] {
  const asked = outcome.create;
  if (outcome.success || !asked) return [];
  const start = Date.parse(outcome.requested?.startAt ?? '');
  let closest: string[] | null = null;
  for (const made of outcomes) {
    if (!made.success || !made.create || !sameEvent(made, made.create, asked, start)) continue;
    const differing = differingBetween(made.create, asked);
    if (closest === null || differing.length < closest.length) closest = differing;
  }
  return closest ?? [];
}

/** A success of the same title, in the same calendar, at the same start (as keyed, or as first requested). */
function sameEvent(made: WriteOutcome, had: CreateKeys, asked: CreateKeys, askedStart: number): boolean {
  const sameCalendar = had.parts.owner === asked.parts.owner && had.parts.scope === asked.parts.scope;
  if (!sameCalendar || had.parts.title !== asked.parts.title) return false;
  return had.parts.start === asked.parts.start || Date.parse(made.requested?.startAt ?? '') === askedStart;
}

/** The create fields two requests for one event disagree on, by field name. */
function differingBetween(had: CreateKeys, asked: CreateKeys): string[] {
  const names: [string, boolean][] = [
    ['recurrence_rule', had.parts.recurrence !== asked.parts.recurrence],
    ['all_day', had.parts.allDay !== asked.parts.allDay],
    ['end_at', had.details.end !== asked.details.end],
    ['location', had.details.location !== asked.details.location],
    ['description', had.details.description !== asked.details.description],
  ];
  return names.filter(([, differs]) => differs).map(([name]) => name);
}

/** What the receipt needs from the run's context; built by `receiptView`. */
export interface ReceiptView {
  language: string;
  timezone: string;
  hideTargets: boolean;
  requesterId: number;
  now: Date;
  /** A name the requester may be shown for this person, or null. Already inert (see `inert`). */
  personLabel: (person: Invitee) => string | null;
  /** One key per real person: a contact named by @username (any case) and by id is the same person. */
  personKey: (person: Invitee) => string;
  /** The name of a calendar the requester manages as an active secretary, or null. Already inert. */
  calendarOwnerName: (ownerId: number) => string | null;
  /** Whether the requester holds an active secretary delegation for this calendar. */
  hasCalendarAccess: (ownerId: number) => boolean;
}

/**
 * Text the model or another user wrote, made safe for the one renderer the receipt goes through
 * (TelegramStreamWriter -> markdownToHtml). That renderer already HTML-escapes `<`, `>` and `&`, so
 * escaping them here would show "&amp;"; it has no way to escape `*`, `_` and backticks, so a
 * title like "_a **b_ c**" would come out as overlapping tags that Telegram rejects, and the
 * receipt would never arrive. Those characters become look-alikes, and line breaks collapse so
 * a title cannot pass itself off as another receipt line.
 */
function inert(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/\*/g, '∗').replace(/_/g, '＿').replace(/`/g, 'ˋ');
}

function cleanName(value: string | null | undefined): string | null {
  const name = value ? [...inert(value)].slice(0, 40).join('') : '';
  return name || null;
}

/**
 * A username is only `\w` characters, so an underscore inside it can neither open nor close
 * emphasis; only a leading or trailing run can, and those are the ones swapped.
 */
function inertUsername(username: string): string {
  return username.replace(/^_+|_+$/g, (run) => '＿'.repeat(run.length));
}

export function receiptView(ctx: AgentContext): ReceiptView {
  const requesterId = ctx.user.telegram_id;
  const hasCalendarAccess = (ownerId: number): boolean =>
    ctx.secretary?.secretaryRepo.findByOwnerAndSecretary(ownerId, requesterId)?.status === 'active';
  return {
    language: ctx.user.language,
    timezone: ctx.user.timezone,
    hideTargets: ctx.isGroup,
    requesterId,
    now: new Date(),
    personKey: ({ id, username }) => {
      if (id !== null) return `id:${id}`;
      const contactId = username === null ? null : ctx.contactRepo?.findByUsername(requesterId, username)?.telegram_id;
      return contactId ? `id:${contactId}` : `@${(username ?? '').toLowerCase()}`;
    },
    personLabel: ({ id, username }) => {
      if (id !== null) {
        if (id === requesterId) return cleanName(ctx.user.first_name);
        return cleanName(ctx.contactRepo?.findByTelegramId(requesterId, id)?.name);
      }
      if (username === null) return null;
      const contact = ctx.contactRepo?.findByUsername(requesterId, username);
      return cleanName(contact?.name) ?? `@${inertUsername(username)}`;
    },
    hasCalendarAccess,
    calendarOwnerName: (ownerId) =>
      hasCalendarAccess(ownerId) ? cleanName(ctx.userRepo.findByTelegramId(ownerId)?.first_name) : null,
  };
}

type Tr = Messages['writeOutcomes'];
type Standing = 'done' | 'rejected' | 'unknown' | 'skipped';
type InviteStanding = 'sent' | 'created' | 'manual' | 'undelivered' | 'rejected' | 'unknown' | 'skipped';
const INVITE_ORDER: readonly InviteStanding[] = [
  'sent',
  'created',
  'manual',
  'undelivered',
  'rejected',
  'unknown',
  'skipped',
];
type EventOperation = keyof Tr['operations'];

function isEventOperation(operation: string): operation is EventOperation {
  return Object.hasOwn(t('en').writeOutcomes.operations, operation);
}

function standingOf(outcome: WriteOutcome): Standing {
  if (outcome.disposition === 'skipped') return 'skipped';
  if (outcome.success) return 'done';
  return outcome.mutationState === 'not_applied' ? 'rejected' : 'unknown';
}

function inviteStandingOf(outcome: WriteOutcome): InviteStanding {
  const standing = standingOf(outcome);
  if (standing !== 'done') return standing;
  if (outcome.effect?.kind !== 'invitation') return 'created';
  if (outcome.effect.delivery === 'delivered') return 'sent';
  return outcome.effect.delivery === 'manual_forward' ? 'manual' : 'undelivered';
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^\d{2}:\d{2}$/;

/** A real calendar date in `YYYY-MM-DD` form: "2030-02-31" and "01/01/2030" are not. */
function isIsoDay(day: string): boolean {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return ISO_DAY.test(day) && Number.isFinite(ms) && new Date(ms).toISOString().startsWith(day);
}

/** The event's local day and time, read from the raw start its own write carried. */
function localDayTime(ref: Timing, timezone: string): { day: string | null; time: string | null } {
  if (ref.startAt === null) return { day: null, time: null };
  // The tool contract: a real ISO date, or a datetime with Z or an offset. Anything else has no readable day.
  const ms = Date.parse(ref.startAt);
  if (!Number.isFinite(ms) || !eventTimestampSchema.safeParse(ref.startAt).success) return { day: null, time: null };
  if (ref.allDay) return { day: allDayCalendarDate(ref.startAt, timezone), time: null };
  const local = new TZDate(ms, timezone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    day: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
  };
}

/** "today, 17:00" / "1 November, 09:00" / "tomorrow", from the event's local day and time. */
function describeWhen(ref: Timing, view: ReceiptView): string | null {
  const { day, time } = localDayTime(ref, view.timezone);
  if (day === null || !isIsoDay(day)) return null;
  const lang = toLang(view.language);
  const delta = Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${localToday(view.now, view.timezone).today}T00:00:00Z`)) / DAY_MS,
  );
  const dayText =
    relativeDayWord(t(lang).aiTools.events.emptyAgenda.relativeDay, delta) ?? describeCalendarDay(day, lang).day;
  return time !== null && CLOCK_TIME.test(time) ? `${dayText}, ${time}` : dayText;
}

/**
 * The receipt is the only thing the user reads when the guard fires, and its date comes from a
 * model-supplied string and a stored timezone: a bad one costs the receipt its day and time,
 * never the receipt (an invalid zone makes TZDate and Intl throw RangeError).
 */
function whenOf(ref: Timing, view: ReceiptView): string | null {
  try {
    return describeWhen(ref, view);
  } catch {
    return null;
  }
}

interface PlainLine {
  base: string;
  reason: string | null;
  fields: string[];
}
interface InviteGroup {
  event: EventRef | null;
  byStanding: Map<InviteStanding, Invitee[]>;
}
type Entry =
  | { kind: 'plain'; line: PlainLine }
  | { kind: 'text'; text: string }
  | { kind: 'invites'; group: InviteGroup };

/** The distinct people of one receipt line: how many, and who is named (the rest, and a second person with an already shown name, are only counted). */
function describePeople(people: readonly Invitee[], view: ReceiptView, tr: Tr): { count: number; text: string } {
  const seen = new Set<string>();
  const names: string[] = [];
  let unnamed = 0;
  for (const person of people) {
    const key = view.personKey(person);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = view.hideTargets ? null : view.personLabel(person);
    if (!label) unnamed++;
    else if (names.includes(label)) unnamed++;
    else names.push(label);
  }
  return { count: seen.size, text: tr.people(names, unnamed) };
}

interface Draft {
  entries: Entry[];
  plain: Map<string, PlainLine>;
  groups: Map<string, InviteGroup>;
}

/** ", <whose calendar>" when the write went to someone else's calendar, otherwise nothing. */
function calendarSuffix(
  outcome: WriteOutcome,
  events: ReadonlyMap<number, KnownEvent>,
  view: ReceiptView,
  tr: Tr,
): string {
  const owner = outcome.owner ?? (outcome.eventId !== null ? (events.get(outcome.eventId)?.owner ?? null) : null);
  if (view.hideTargets || owner === null || owner === view.requesterId) return '';
  const name = view.calendarOwnerName(owner);
  // Never state an access the requester does not hold (denied, revoked, expired, or an invented id).
  const unnamed = view.hasCalendarAccess(owner) ? tr.delegatedCalendar : tr.otherCalendar;
  return `, ${name ? tr.calendarOf(name) : unnamed}`;
}

/** Invitations to one event are told together: the person joins the event's group under their outcome. */
function addInvitation(draft: Draft, outcome: WriteOutcome, invitee: Invitee, ref: EventRef | null): void {
  const groupKey = String(outcome.eventId);
  let group = draft.groups.get(groupKey);
  if (!group) {
    group = { event: ref, byStanding: new Map() };
    draft.groups.set(groupKey, group);
    draft.entries.push({ kind: 'invites', group });
  }
  const inviteStanding = inviteStandingOf(outcome);
  group.byStanding.set(inviteStanding, [...(group.byStanding.get(inviteStanding) ?? []), invitee]);
}

/**
 * The sentence for a successful write whose result is a side effect, not an event change: what
 * reached an invitee (a resend, or a name that could not be read), or a declined attendance.
 * Null for every other outcome.
 */
function effectText(outcome: WriteOutcome, ref: EventRef | null, tr: Tr): string | null {
  if (!outcome.success) return null;
  if (outcome.effect?.kind === 'invitation') {
    return {
      delivered: tr.invitationDelivered,
      manual_forward: tr.invitationManual,
      failed: tr.invitationFailed,
    }[outcome.effect.delivery];
  }
  return outcome.effect?.kind === 'attendance_declined' ? tr.attendanceDeclined(ref?.title ?? null) : null;
}

/** The sentence for one write to an event and, when it did not go through, why. */
function plainLineOf(
  outcome: WriteOutcome,
  ref: EventRef | null,
  calendar: string,
  view: ReceiptView,
  tr: Tr,
): { base: string; reason: string | null } {
  const standing = standingOf(outcome);
  const labels = isEventOperation(outcome.operation) ? tr.operations[outcome.operation] : tr.otherWrite;
  const done = outcome.alreadyExists ? tr.alreadyThere : labels.done;
  const prefix = standing === 'done' ? done : standing === 'unknown' ? labels.unknown : labels.notDone;
  const when = ref ? whenOf(ref, view) : null;
  const subject = isEventOperation(outcome.operation) ? (ref ? tr.eventNamed(ref.title, when) : tr.anEvent) : tr.change;
  const reason = standing === 'rejected' ? tr.nothingChanged : standing === 'skipped' ? tr.skipped : null;
  return { base: `${prefix}: ${subject}${calendar}`, reason };
}

/** One line for a write to an event; the per-field lines of one event fold into one. */
function addPlainLine(
  draft: Draft,
  outcome: WriteOutcome,
  text: { base: string; reason: string | null },
  tr: Tr,
  details: readonly string[],
): void {
  const { base, reason } = text;
  // Only the per-field lines of one event fold into one; two writes to unnamed events stay two.
  const key = outcome.field ? `${outcome.eventId}\u0000${base}\u0000${reason}` : null;
  let line = key ? draft.plain.get(key) : undefined;
  if (!line) {
    line = { base, reason, fields: [] };
    if (key) draft.plain.set(key, line);
    draft.entries.push({ kind: 'plain', line });
  }
  for (const name of outcome.field ? [outcome.field, ...details] : details) {
    const label = Object.hasOwn(tr.fields, name) ? Reflect.get(tr.fields, name) : tr.field;
    if (!line.fields.includes(label)) line.fields.push(label);
  }
}

/** The event a write was about, with its title made inert; null where targets are hidden or nothing names it. Its timing is only what that write carried. */
function refOf(outcome: WriteOutcome, events: ReadonlyMap<number, KnownEvent>, view: ReceiptView): EventRef | null {
  const title = outcome.requested?.title ?? (outcome.eventId !== null ? events.get(outcome.eventId)?.title : undefined);
  const timing = outcome.requested ?? outcome.timing ?? { startAt: null, allDay: false };
  return inertRef(title === undefined ? null : { ...timing, title }, view);
}

/** Every title in the receipt passes through here: it is the model's text or the user's, never ours. */
function inertRef(named: EventRef | null, view: ReceiptView): EventRef | null {
  return view.hideTargets || !named ? null : { ...named, title: inert(named.title) };
}

/**
 * A create answered "already exists" is the event found again by its id: it tells nothing that a successful
 * create of that same event recorded before it (made by this run, or found there by an earlier repeat) has not told.
 */
function repeatsToldEvent(outcomes: readonly WriteOutcome[], index: number): boolean {
  const id = outcomes[index]?.alreadyExists?.id;
  return (
    id !== undefined &&
    outcomes.some(
      (other, i) => i < index && other.operation === 'create_event' && other.success && other.eventId === id,
    )
  );
}

/** Files one recorded write under the kind of line it is told as: an invitation, a side effect or an event change. */
function addOutcome(
  draft: Draft,
  outcome: WriteOutcome,
  events: ReadonlyMap<number, KnownEvent>,
  view: ReceiptView,
  tr: Tr,
  outcomes: readonly WriteOutcome[],
): void {
  const ref = refOf(outcome, events, view);
  if (outcome.operation === 'send_invitation' && outcome.invitee) {
    addInvitation(draft, outcome, outcome.invitee, ref);
    return;
  }
  const text = effectText(outcome, ref, tr);
  if (text === null) {
    const line = plainLineOf(outcome, ref, calendarSuffix(outcome, events, view, tr), view, tr);
    addPlainLine(draft, outcome, line, tr, differingFields(outcome, outcomes));
    return;
  }
  // Two resends reporting the same delivery are one sentence; a declined attendance is told each time.
  const repeated = draft.entries.some((entry) => entry.kind === 'text' && entry.text === text);
  if (outcome.effect?.kind !== 'invitation' || !repeated) draft.entries.push({ kind: 'text', text });
}

function renderEntry(entry: Entry, view: ReceiptView, tr: Tr): string[] {
  if (entry.kind === 'text') return [entry.text];
  if (entry.kind === 'plain') {
    const { base, fields, reason } = entry.line;
    return [`${base}${fields.length ? tr.changedFields(fields) : ''}${reason ? ` — ${reason}` : ''}.`];
  }
  const { event, byStanding } = entry.group;
  const named = event ? tr.eventTitle(event.title) : tr.theEvent;
  return INVITE_ORDER.flatMap((standing) => {
    const people = byStanding.get(standing);
    if (!people) return [];
    const { count, text } = describePeople(people, view, tr);
    return [tr.invitations[standing](count, named, text)];
  });
}

/**
 * The receipt for every recorded write, in the order the targets first appeared; null when there
 * is nothing to say. Invitations to one event are told together, one line per outcome.
 */
export function renderReceipt(
  outcomes: readonly WriteOutcome[],
  events: ReadonlyMap<number, KnownEvent>,
  view: ReceiptView,
  interrupted: boolean,
): string | null {
  const tr = t(toLang(view.language)).writeOutcomes;
  const draft: Draft = { entries: [], plain: new Map(), groups: new Map() };
  const standings = outcomes.map(standingOf);
  const unknown = standings.includes('unknown');
  const rejected = standings.includes('rejected');
  const duplicateRisk = outcomes.some((outcome) => outcome.unknownRetried);

  outcomes.forEach((outcome, index) => {
    if (!repeatsToldEvent(outcomes, index)) addOutcome(draft, outcome, events, view, tr, outcomes);
  });

  const lines = draft.entries.flatMap((entry) => renderEntry(entry, view, tr));
  if (duplicateRisk) lines.push(tr.retriedAfterUnknown);
  const repeats = new Set<string>();
  for (const outcome of outcomes) {
    for (const repeated of outcome.repeatUnknown) {
      const ref = inertRef(repeated, view);
      const event = ref
        ? `${tr.eventNamed(ref.title, whenOf(ref, view))}${calendarSuffix(outcome, events, view, tr)}`
        : null;
      repeats.add(tr.repeatUnknown(event));
    }
  }
  lines.push(...repeats);

  // A possible duplicate is also a reason to check the calendar before repeating a refused write.
  if (unknown || (rejected && (duplicateRisk || repeats.size > 0))) lines.push(tr.checkFirst);
  else if (rejected) lines.push(tr.retry);
  if (interrupted) lines.push(tr.interrupted);
  return lines.join('\n') || null;
}
