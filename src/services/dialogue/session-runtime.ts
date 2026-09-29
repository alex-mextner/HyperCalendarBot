// src/services/dialogue/session-runtime.ts
//
// The ONE shared "what happens with this draft next" engine for GH-652's dialogue runtime —
// used by both the `/add` full-field fast path (add-v3.ts) and the natural-text entry adapter
// (dialogue-v3-layer.ts) so a fix here (or a correctness gap closed here) applies to both entry
// points identically, never drifting into two half-duplicated copies (that drift is exactly
// what the 2026-09-28 parent review found: a fuzzy-person bug fixed in one file and not the
// other). Owns:
// - Merging a parser patch onto a draft with real field provenance (v3-types.ts).
// - The one true readiness/negation/unresolved-name gate before anything executes.
// - The one true execution pipeline: compare-and-swap "executing" reservation (so two
//   concurrent turns for the same session can never both create the event), the real
//   `EventService.createEvent` call, real invitation delivery for resolved people (never a raw
//   `participantRepo.add(pending)` — that is not an invitation), the existing post-create Google
//   push and place-verification hooks, and the receipt card.
// - Compare-and-swap persistence for every non-terminal session write (asking a question,
//   parking a fuzzy/unresolved-name confirmation), so a late/duplicate turn can never silently
//   clobber a newer answer.

import { eventActionsKeyboard } from '../../bot/keyboards.ts';
import { applyDefaultDuration } from '../../bot/scenes/add-event.scene.ts';
import type { BotCommandContext } from '../../bot/types.ts';
import { t } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type {
  DialogueSessionKey,
  DialogueSessionRepository,
} from '../../database/repositories/dialogue-session.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CalendarEvent, User } from '../../database/types.ts';
import { escapeHtml, splitMessage } from '../../utils/telegram.ts';
import { deliverInvitation } from '../ai/invitation-delivery.ts';
import type { TelegramSender } from '../ai/types.ts';
import { type CalendarDay, localMidnightInstant } from '../calendar/wall-clock.ts';
import type { EventService } from '../event/event-service.ts';
import { formatEventDetail } from '../event/formatters.ts';
import type { LocationVerificationService } from '../location/location-verification-service.ts';
import type { DeepLinkService } from '../sharing/deep-link-service.ts';
import type { InvitationService } from '../sharing/invitation-service.ts';
import type { FuzzyPersonMention, ParseResult } from './full-field-parser.ts';
import { checkReadiness, nextQuestion } from './session-machine.ts';
import {
  type DialogueV3Session,
  type DraftFieldName,
  type DraftPerson,
  type EffectLedger,
  type EventCreateDraft,
  type ExecutionReceipt,
  emptyDraft,
  type FieldProvenance,
  type InviteOutcome,
  isEffectLedgerReconciled,
  PENDING_EFFECT_LEDGER,
  type PendingFuzzyPerson,
} from './v3-types.ts';

export { emptyDraft, type InviteOutcome };

/** Real delivery deps — same shape callback.handler.ts's own `pickerInvitationDeps` already builds in bot/index.ts, reused verbatim rather than re-invented. */
export interface InvitationDeliveryRuntimeDeps {
  readonly sender: TelegramSender;
  readonly invitationRepo: InvitationRepository;
  readonly userRepo: UserRepository;
  readonly deepLinkService?: DeepLinkService;
  readonly botUsername?: string;
  readonly contactRepo?: ContactRepository;
}

export interface SessionRuntimeDeps {
  readonly eventService: EventService;
  readonly dialogueSessions: DialogueSessionRepository;
  readonly invitationService?: InvitationService;
  readonly invitationDelivery?: InvitationDeliveryRuntimeDeps;
  readonly actionLogRepo?: ActionLogRepository;
  /** The exact hook add-event.scene.ts's own `onEventCreated` already reuses (googleSchedulePush bound to 'create') — never duplicated, never reinvented here. */
  readonly onEventCreated?: (userId: number, eventId: number) => Promise<void>;
  readonly locationVerification?: Pick<LocationVerificationService, 'verifyEventLocation'>;
}

/** ISO calendar-day string ("YYYY-MM-DD") parsed into wall-clock.ts's `CalendarDay` shape. */
function parseIsoDay(isoDayStr: string): CalendarDay {
  const [y, m, d] = isoDayStr.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

/**
 * The one all-day boundary instant this runtime ever stores — `wall-clock.ts`'s
 * `localMidnightInstant`, reused verbatim rather than a second UTC-midnight conversion. A second
 * conversion is exactly the bug this replaces: `new Date(ms).toISOString()` always renders "Z",
 * discarding the zone's real offset and silently shifting the stored calendar-date prefix by a
 * day west of UTC (America/New_York's local midnight would store as the PREVIOUS day). A
 * calendar day whose local midnight a clock change skipped entirely (e.g. Pacific/Apia's
 * 2011-12-30) has no valid instant — rejected outright, before any durable state (the CAS
 * reservation, the event row) exists, never silently normalized onto a neighboring day.
 */
function localMidnightOrThrow(isoDayStr: string, timezone: string): string {
  const instant = localMidnightInstant(parseIsoDay(isoDayStr), timezone);
  if (instant === null) {
    throw new Error(`local midnight for ${isoDayStr} in ${timezone} does not exist (skipped by a clock change)`);
  }
  return instant;
}

/** Applies one turn's parse patch onto a draft, updating field provenance honestly — never silently overwrites a `supplied` field back to `missing`. */
export function applyParseResultToDraft(
  draft: EventCreateDraft,
  patch: ParseResult['patch'],
  defaultDurationMinutes: number,
): EventCreateDraft {
  const provenance: Record<DraftFieldName, FieldProvenance> = { ...draft.provenance };
  let schedule = draft.schedule;
  let endAt = draft.endAt;
  if (patch.schedule !== undefined) {
    schedule = patch.schedule;
    provenance.schedule = 'supplied';
    endAt = schedule.kind === 'timed' ? applyDefaultDuration(schedule.startAt, defaultDurationMinutes) : undefined;
  }
  const title = patch.title !== undefined ? patch.title : draft.title;
  if (patch.title !== undefined) provenance.title = 'supplied';
  const place = patch.place !== undefined ? patch.place : draft.place;
  if (patch.place !== undefined) provenance.place = 'supplied';
  const people = patch.people && patch.people.length > 0 ? [...draft.people, ...patch.people] : draft.people;
  if (patch.people && patch.people.length > 0) provenance.people = 'supplied';
  return { ...draft, title, schedule, endAt, place, people, provenance };
}

export interface ReadinessGateInput {
  readonly fuzzyPeople: readonly FuzzyPersonMention[];
  readonly negated: boolean;
  readonly unresolvedPeopleNames: readonly string[];
}

/** Thin, honest wrapper over session-machine's checkReadiness — the one call site every consumer routes through. */
export function readinessGate(draft: EventCreateDraft, input: ReadinessGateInput) {
  return checkReadiness(draft, input);
}

/** Merges a fresh fuzzy/unresolved-name mention list into the session's pending-confirmation queue — an unresolved name (no contact matched at all) is represented with an empty `candidates` array, never conflated with a real fuzzy match, never silently dropped (see v3-types.ts's DialogueV3Session.pendingFuzzyPeople doc). */
export function toPendingConfirmations(
  fuzzyPeople: readonly FuzzyPersonMention[],
  unresolvedPeopleNames: readonly string[],
): readonly PendingFuzzyPerson[] {
  return [
    ...fuzzyPeople.map((f) => ({ rawName: f.rawName, candidates: f.candidates })),
    ...unresolvedPeopleNames.map((rawName) => ({ rawName, candidates: [] })),
  ];
}

/**
 * Real invitation delivery for every resolved, confirmed person with a linked Telegram account —
 * `InvitationService.sendInvitation` (creates the actual `Invitation` row) followed by
 * `deliverInvitation` (Bot API → MTProto → deep-link fallback, same path `send_invitation`'s AI
 * tool handler uses), never a raw `participantRepo.add('pending')` masquerading as an invite.
 * A person with no linked Telegram account cannot be invited at all (no delivery target) — never
 * silently claimed invited; surfaced as `noAccount` for the receipt to disclose honestly.
 */
export async function inviteResolvedPeople(
  event: CalendarEvent,
  user: User,
  people: readonly DraftPerson[],
  lang: 'en' | 'ru',
  deps: Pick<SessionRuntimeDeps, 'invitationService' | 'invitationDelivery'>,
): Promise<InviteOutcome> {
  const delivered: DraftPerson[] = [];
  const pendingManualForward: DraftPerson[] = [];
  const noAccount: DraftPerson[] = [];
  const failed: { person: DraftPerson; reason: string }[] = [];
  if (!deps.invitationService) {
    for (const person of people) failed.push({ person, reason: 'invitations not configured' });
    return { delivered, pendingManualForward, noAccount, failed };
  }
  for (const person of people) {
    if (!person.telegramId) {
      noAccount.push(person);
      continue;
    }
    const result = deps.invitationService.sendInvitation(event.id, user.telegram_id, person.telegramId);
    if (!result.success || !result.invitation) {
      failed.push({ person, reason: result.error ?? 'unknown error' });
      continue;
    }
    if (!deps.invitationDelivery) {
      // The Invitation row exists, but no delivery channel was ever configured — never claim
      // delivered when delivery was never even attempted.
      failed.push({ person, reason: 'delivery not configured' });
      continue;
    }
    try {
      const delivery = await deliverInvitation({
        invitationId: result.invitation.id,
        eventId: event.id,
        inviteeId: person.telegramId,
        inviteeName: person.displayName,
        inviterId: user.telegram_id,
        inviterName: user.first_name ?? user.username ?? `User ${user.telegram_id}`,
        inviterUsername: user.username ?? undefined,
        inviterTimezone: user.timezone,
        event,
        lang,
        inviterLang: lang,
        fallbackChatId: user.telegram_id,
        allowMtproto: true,
        isGroupTarget: false,
        deps: {
          sender: deps.invitationDelivery.sender,
          invitationRepo: deps.invitationDelivery.invitationRepo,
          userRepo: deps.invitationDelivery.userRepo,
          deepLinkService: deps.invitationDelivery.deepLinkService,
          botUsername: deps.invitationDelivery.botUsername,
          contactRepo: deps.invitationDelivery.contactRepo,
        },
      });
      // Classification mirrors handleSendInvitation's own (send_invitation AI tool) contract
      // exactly: `delivered` only when the Bot API or MTProto actually reached the invitee;
      // `viaDeepLink` means only the INVITER got a link to forward, never the invitee directly;
      // anything else is an honest failure — never inferred from "the Invitation row exists".
      if (delivery.delivered) delivered.push(person);
      else if (delivery.viaDeepLink) pendingManualForward.push(person);
      else failed.push({ person, reason: 'delivery failed' });
    } catch (err) {
      // The Invitation record was created (real, queryable, resendable via /invitations) even
      // though live delivery threw — reported as a failure, never silently upgraded to delivered.
      failed.push({ person, reason: err instanceof Error ? err.message : 'delivery threw' });
    }
  }
  return { delivered, pendingManualForward, noAccount, failed };
}

/**
 * Post-create Google push + place verification, run to completion and durably tracked — never
 * fire-and-forget. A rejection from either hook is a genuine "did the external system actually
 * receive it" unknown the effect ledger must capture for operator/user reconciliation, so this
 * throws on the first rejection instead of the previous `.catch(() => {})` silent swallow that
 * made a live Google-push failure indistinguishable from success.
 */
export async function runPostCreateHooks(
  event: CalendarEvent,
  user: User,
  deps: Pick<SessionRuntimeDeps, 'onEventCreated' | 'locationVerification'>,
): Promise<void> {
  const hooks: Promise<unknown>[] = [];
  if (deps.onEventCreated) hooks.push(deps.onEventCreated(user.telegram_id, event.id));
  if (event.location && deps.locationVerification) {
    hooks.push(deps.locationVerification.verifyEventLocation(event, user));
  }
  await Promise.all(hooks);
}

function inviteDisclosureLines(outcome: InviteOutcome, lang: 'en' | 'ru'): string[] {
  const lines: string[] = [];
  if (outcome.noAccount.length > 0) {
    const names = outcome.noAccount.map((p) => p.displayName).join(', ');
    lines.push(
      lang === 'ru'
        ? `⚠️ ${names} — нет привязанного Telegram, не уведомлен(а).`
        : `⚠️ ${names} — no linked Telegram account, not notified.`,
    );
  }
  if (outcome.pendingManualForward.length > 0) {
    const names = outcome.pendingManualForward.map((p) => p.displayName).join(', ');
    lines.push(
      lang === 'ru'
        ? `⚠️ ${names} — не удалось доставить напрямую; ссылка отправлена тебе для пересылки.`
        : `⚠️ ${names} — could not deliver directly; a link was sent to you to forward manually.`,
    );
  }
  if (outcome.failed.length > 0) {
    const names = outcome.failed.map((f) => f.person.displayName).join(', ');
    lines.push(lang === 'ru' ? `⚠️ Не удалось пригласить: ${names}.` : `⚠️ Could not invite: ${names}.`);
  }
  return lines;
}

/** Sends the standard confirmation card — identical formatters/keyboard the legacy wizard uses — plus an honest invite-outcome disclosure, never silently omitted. */
export async function sendReceipt(
  ctx: BotCommandContext,
  event: CalendarEvent,
  timezone: string,
  title: string,
  inviteOutcome: InviteOutcome,
): Promise<void> {
  const disclosure = inviteDisclosureLines(inviteOutcome, ctx.lang);
  const body = [
    `${t(ctx.lang).event_created(escapeHtml(title))}`,
    '',
    formatEventDetail(event, timezone, ctx.lang),
    ...disclosure,
  ]
    .join('\n')
    .trim();
  const receipt = splitMessage(body, 4000, 'HTML');
  for (const [index, chunk] of receipt.entries()) {
    await ctx.send(chunk, {
      parse_mode: 'HTML',
      ...(index === receipt.length - 1 ? { reply_markup: eventActionsKeyboard(event.id, ctx.lang) } : {}),
    });
  }
}

export type ExecuteOutcome =
  | { readonly kind: 'executed'; readonly event: CalendarEvent }
  | { readonly kind: 'race_lost' };

const EMPTY_INVITE_OUTCOME: InviteOutcome = { delivered: [], pendingManualForward: [], noAccount: [], failed: [] };

/**
 * Advances a durable session's effect ledger by exactly the effects still `pending` — never an
 * already-`applied`/`unknown`/`failed` one. Each attempt is bracketed by two CAS writes: `unknown`
 * right before the call runs, then the real completion status right after. Unlike the earlier
 * draft of this fix, a LOST CAS write now aborts the entire remaining sequence immediately,
 * before any further side effect runs — a concurrent writer (two overlapping resumes of the same
 * unreconciled session, e.g. from a duplicate/retried Telegram update) can therefore never both
 * reach a real network side effect (an invitation send, a Google push, a Telegram receipt) for
 * the same still-`pending` slot: whichever call's pre-attempt CAS write wins is the only one that
 * ever calls the effect; the loser aborts with its ledger exactly as it was, matching what is
 * actually durable, so it can never wrongly believe the ledger is reconciled or delete the row a
 * winner is still using. A hard crash between a successful pre-attempt write and the completion
 * write (never observed by THIS process, which is why every caught exception below still
 * resolves to a definite write) leaves the ledger honestly `unknown` for a later
 * `resumeExecutedSession` call to find — never silently retried.
 */
async function runDurableEffects(
  ctx: BotCommandContext,
  event: CalendarEvent,
  user: User,
  draft: EventCreateDraft,
  sessionShell: DialogueV3Session,
  casRevision: number,
  appliedAtRevision: number,
  key: DialogueSessionKey,
  ledger: EffectLedger,
  inviteOutcomeSoFar: InviteOutcome | null,
  deps: SessionRuntimeDeps,
): Promise<{ readonly ledger: EffectLedger; readonly revision: number; readonly inviteOutcome: InviteOutcome | null }> {
  let current = ledger;
  let revision = casRevision;
  let inviteOutcome = inviteOutcomeSoFar;

  /** Returns `false` on a lost CAS race — the caller MUST stop attempting further effects. */
  const persist = (next: EffectLedger, outcome: InviteOutcome | null): boolean => {
    const receipt: ExecutionReceipt = {
      status: 'applied',
      eventId: event.id,
      appliedAtRevision,
      effects: next,
      inviteOutcome: outcome,
    };
    const result = deps.dialogueSessions.set(
      key,
      { ...sessionShell, status: 'executed', executionReceipt: receipt, updatedAt: Date.now() },
      revision,
    );
    if (!result.ok) return false;
    revision = result.revision;
    current = next;
    inviteOutcome = outcome;
    return true;
  };

  if (current.invitations === 'pending' && persist({ ...current, invitations: 'unknown' }, inviteOutcome)) {
    try {
      const outcome = await inviteResolvedPeople(event, user, draft.people, ctx.lang, deps);
      persist({ ...current, invitations: 'applied' }, outcome);
    } catch {
      persist({ ...current, invitations: 'unknown' }, inviteOutcome);
    }
  }

  if (current.postCreateHooks === 'pending' && persist({ ...current, postCreateHooks: 'unknown' }, inviteOutcome)) {
    try {
      await runPostCreateHooks(event, user, deps);
      persist({ ...current, postCreateHooks: 'applied' }, inviteOutcome);
    } catch {
      persist({ ...current, postCreateHooks: 'unknown' }, inviteOutcome);
    }
  }

  if (current.receipt === 'pending' && persist({ ...current, receipt: 'unknown' }, inviteOutcome)) {
    try {
      // A crash-recovered resume that never re-ran invitations (still `unknown`/`failed`) has no
      // real outcome to disclose — the empty fallback is an honest "nothing more is known here",
      // never a claim that everyone was successfully invited.
      await sendReceipt(ctx, event, sessionShell.timezone, draft.title ?? '', inviteOutcome ?? EMPTY_INVITE_OUTCOME);
      persist({ ...current, receipt: 'applied' }, inviteOutcome);
    } catch {
      persist({ ...current, receipt: 'unknown' }, inviteOutcome);
    }
  }

  return { ledger: current, revision, inviteOutcome };
}

/**
 * The one irreversible transition. Compare-and-swap reserves the session as `executing` at the
 * caller's `expectedRevision` BEFORE creating anything — a second concurrent call for the same
 * session (a duplicate webhook, a retried update) loses the CAS race and returns `race_lost`
 * without ever calling `EventService.createEvent`, so the event can never be created twice for
 * one draft. The all-day boundary instant is resolved BEFORE that reservation: a calendar day
 * whose local midnight a clock change skipped (`localMidnightOrThrow`) throws before any durable
 * state exists, never leaving a stray `executing` row behind.
 *
 * The session is deleted only once EVERY durable post-create effect (real invitation delivery,
 * the Google-push/place-verification hooks, the receipt card — `runDurableEffects`) is `applied`
 * — never immediately after the event row exists. A crash/failure anywhere in that sequence
 * leaves the session durably `executed` with the real `eventId` and an honest per-effect ledger,
 * so a later `resumeExecutedSession` call can find it, run only what is still `pending`, and
 * never blind-retry an effect whose outcome is genuinely unknown.
 */
export async function executeDraft(
  ctx: BotCommandContext,
  user: User,
  draft: EventCreateDraft,
  timezone: string,
  sessionShell: DialogueV3Session,
  expectedRevision: number | null,
  key: DialogueSessionKey,
  deps: SessionRuntimeDeps,
): Promise<ExecuteOutcome> {
  if (!draft.title || !draft.schedule) throw new Error('executeDraft called on a not-ready draft');

  const startAt =
    draft.schedule.kind === 'timed' ? draft.schedule.startAt : localMidnightOrThrow(draft.schedule.startDate, timezone);
  const endAt =
    draft.schedule.kind === 'timed'
      ? (draft.endAt ?? applyDefaultDuration(draft.schedule.startAt, user.default_event_duration_minutes ?? 60))
      : localMidnightOrThrow(draft.schedule.endDateExclusive, timezone);

  const reservation = deps.dialogueSessions.set(
    key,
    {
      ...sessionShell,
      status: 'executing',
      executionReceipt: { status: 'unknown', attemptedAtRevision: expectedRevision ?? 0 },
    },
    expectedRevision,
  );
  if (!reservation.ok) return { kind: 'race_lost' };

  const event = deps.eventService.createEvent({
    user_id: user.telegram_id,
    title: draft.title,
    start_at: startAt,
    end_at: endAt,
    all_day: draft.schedule.kind === 'all_day',
    timezone,
    location: draft.place?.label,
    ...(draft.scope === 'group' && draft.groupId
      ? { owner_type: 'group' as const, group_id: draft.groupId, created_by: user.telegram_id }
      : {}),
  });

  deps.actionLogRepo?.insert({
    user_id: user.telegram_id,
    chat_id: Number(ctx.chatId ?? user.telegram_id),
    action_type: 'command',
    action_name: 'create_event_v3',
    input_summary: draft.title,
    result_summary: `id: ${event.id}`,
    target_event_id: event.id,
    metadata: JSON.stringify({ startAt, endAt, allDay: draft.schedule.kind === 'all_day' }),
  });

  // The event and this initial ledger write are the durable record from this point on — a crash
  // during any effect below leaves exactly this (or a further-progressed) ledger for
  // `resumeExecutedSession` to find, never a deleted row with no trace of the created event.
  const executedSession: DialogueV3Session = {
    ...sessionShell,
    status: 'executed',
    executionReceipt: {
      status: 'applied',
      eventId: event.id,
      appliedAtRevision: reservation.revision,
      effects: PENDING_EFFECT_LEDGER,
      inviteOutcome: null,
    },
    updatedAt: Date.now(),
  };
  const executedWrite = deps.dialogueSessions.set(key, executedSession, reservation.revision);
  const ledgerRevision = executedWrite.ok ? executedWrite.revision : reservation.revision;

  const { ledger, revision } = await runDurableEffects(
    ctx,
    event,
    user,
    draft,
    executedSession,
    ledgerRevision,
    reservation.revision,
    key,
    PENDING_EFFECT_LEDGER,
    null,
    deps,
  );

  if (isEffectLedgerReconciled(ledger)) deps.dialogueSessions.deleteIfRevision(key, revision);

  return { kind: 'executed', event };
}

/**
 * Crash/restart recovery for a session left `executed` with an unreconciled effect ledger (see
 * `executeDraft`'s doc comment). Re-reads the durable `eventId` — never calls
 * `EventService.createEvent` again — and resumes only the effects still `pending`; an `unknown`
 * or `failed` effect from a prior attempt is left exactly as it is, surfaced for operator/user
 * reconciliation rather than blind-retried. Deletes the session once every effect is `applied`.
 */
export async function resumeExecutedSession(
  ctx: BotCommandContext,
  user: User,
  session: DialogueV3Session,
  key: DialogueSessionKey,
  deps: SessionRuntimeDeps,
): Promise<{ readonly reconciled: boolean }> {
  if (session.status !== 'executed' || session.executionReceipt?.status !== 'applied') {
    return { reconciled: false };
  }
  const { eventId, effects, inviteOutcome, appliedAtRevision } = session.executionReceipt;
  const event = deps.eventService.getEvent(eventId, user.telegram_id);
  if (!event) {
    // The event itself is gone (e.g. deleted since) — no effect here can durably attach to
    // anything anymore; leave the row for manual inspection rather than looping forever.
    return { reconciled: false };
  }
  const result = await runDurableEffects(
    ctx,
    event,
    user,
    session.draft,
    session,
    session.revision,
    appliedAtRevision,
    key,
    effects,
    inviteOutcome,
    deps,
  );
  if (!isEffectLedgerReconciled(result.ledger)) return { reconciled: false };
  deps.dialogueSessions.deleteIfRevision(key, result.revision);
  return { reconciled: true };
}

/**
 * Opportunistic crash recovery before a NEW turn is allowed to touch this key. An `executed`
 * session with unresolved durable effects is the only record of what happened after the event
 * already exists — a fresh draft must never silently CAS-overwrite it. Attempts reconciliation
 * first; only once it is fully reconciled (or there was nothing to reconcile) does the caller
 * proceed as if the key were free.
 */
export async function reconcileBeforeNewTurn(
  ctx: BotCommandContext,
  user: User,
  key: DialogueSessionKey,
  deps: SessionRuntimeDeps,
): Promise<{ readonly blocked: boolean; readonly existing: DialogueV3Session | null }> {
  const existing = deps.dialogueSessions.get(key);
  if (!existing || existing.status !== 'executed') return { blocked: false, existing };
  const resumed = await resumeExecutedSession(ctx, user, existing, key, deps);
  return resumed.reconciled ? { blocked: false, existing: null } : { blocked: true, existing };
}

/** Fixed identity fields a session keeps for its whole lifetime — everything `advance()` does NOT itself decide each turn. */
export interface SessionShell {
  readonly version: 3;
  readonly sessionId: string;
  readonly actorId: number;
  readonly chatId: number;
  readonly topicId: number;
  readonly operation: 'event.create';
  readonly timezone: string;
  readonly createdAt: number;
  readonly sourceText: string;
}

async function sendQuestion(ctx: BotCommandContext, field: string): Promise<void> {
  const prompts: Record<string, { en: string; ru: string }> = {
    title: { en: 'What should I call this event?', ru: 'Как назвать событие?' },
    schedule: { en: 'What time? (or "all day")', ru: 'Во сколько? (или "весь день")' },
  };
  const prompt = prompts[field];
  await ctx.send(prompt ? prompt[ctx.lang] : field);
}

/** Never auto-adds or drops a name mention — always asks, one at a time (design §23). A zero-candidate entry (no contact matched at all) asks for a known name or "skip" instead of a yes/no. */
async function sendFuzzyQuestion(ctx: BotCommandContext, pending: PendingFuzzyPerson): Promise<void> {
  if (pending.candidates.length === 0) {
    await ctx.send(
      ctx.lang === 'ru'
        ? `Не нашёл контакт «${pending.rawName}» — пришли точное имя, которое я знаю, или ответь "skip", чтобы продолжить без него.`
        : `I don't have a contact named "${pending.rawName}" — send a name I know, or reply "skip" to continue without them.`,
    );
    return;
  }
  const candidate = pending.candidates[0];
  const name = candidate?.displayName ?? pending.rawName;
  await ctx.send(
    ctx.lang === 'ru'
      ? `Ты имел в виду ${name} (для "${pending.rawName}")? Ответь да/нет.`
      : `Did you mean ${name} for "${pending.rawName}"? Reply yes/no.`,
  );
}

export type AdvanceOutcome =
  | { readonly kind: 'executed'; readonly event: CalendarEvent }
  | { readonly kind: 'asked' }
  | { readonly kind: 'asked_fuzzy' }
  | { readonly kind: 'blocked_negated' }
  | { readonly kind: 'nothing_to_ask' }
  | { readonly kind: 'race_lost' };

/**
 * The one shared "what happens with this draft next" step, driven by both entry points for
 * every turn (a starter phrase, a full `/add` command, or a continuation reply):
 * 1. A negated turn is a hard stop — cancels/never starts a draft, never offers to "skip" past
 *    it (blocker: parseResult.negated MUST block event.create).
 * 2. A fresh or still-unresolved name mention (real fuzzy match OR zero-candidate unresolved
 *    name) ALWAYS parks on a confirmation before anything else, even when title+schedule are
 *    otherwise complete (blocker: unresolvedPeopleNames/fuzzy people MUST block event.create).
 * 3. Only once there is nothing left pending does readiness get to decide execute-vs-ask.
 * Every non-terminal write is compare-and-swap (`expectedRevision`) — a race loser gets
 * `race_lost` and must re-read the session rather than retry blindly.
 */
export async function advance(
  ctx: BotCommandContext,
  user: User,
  timezone: string,
  key: DialogueSessionKey,
  shell: SessionShell,
  draft: EventCreateDraft,
  selectedDate: string,
  pendingConfirmations: readonly PendingFuzzyPerson[],
  negated: boolean,
  expectedRevision: number | null,
  deps: SessionRuntimeDeps,
): Promise<AdvanceOutcome> {
  if (negated) {
    if (expectedRevision !== null) deps.dialogueSessions.delete(key);
    await ctx.send(
      ctx.lang === 'ru'
        ? 'Похоже, ты просишь НЕ создавать событие — я не буду его создавать. Напиши запрос заново, если событие всё-таки нужно.'
        : "This looks like a request NOT to create something — I won't create an event from this. Rephrase without the negation if you do want one.",
    );
    return { kind: 'blocked_negated' };
  }

  if (pendingConfirmations.length > 0) {
    const [pending] = pendingConfirmations;
    const session: DialogueV3Session = {
      ...shell,
      selectedDate,
      draft,
      pendingField: 'people',
      pendingFuzzyPeople: pendingConfirmations,
      status: 'collecting',
      revision: 0,
      executionReceipt: null,
      updatedAt: Date.now(),
    };
    const result = deps.dialogueSessions.set(key, session, expectedRevision);
    if (!result.ok) return { kind: 'race_lost' };
    await sendFuzzyQuestion(ctx, pending!);
    return { kind: 'asked_fuzzy' };
  }

  const readiness = readinessGate(draft, { fuzzyPeople: [], negated: false, unresolvedPeopleNames: [] });
  if (readiness.ready && draft.title && draft.schedule) {
    const session: DialogueV3Session = {
      ...shell,
      selectedDate,
      draft,
      pendingField: null,
      pendingFuzzyPeople: [],
      status: 'collecting',
      revision: 0,
      executionReceipt: null,
      updatedAt: Date.now(),
    };
    const outcome = await executeDraft(ctx, user, draft, timezone, session, expectedRevision, key, deps);
    return outcome.kind === 'race_lost' ? { kind: 'race_lost' } : { kind: 'executed', event: outcome.event };
  }

  const question = nextQuestion(draft);
  const session: DialogueV3Session = {
    ...shell,
    selectedDate,
    draft,
    pendingField: question?.field ?? null,
    pendingFuzzyPeople: [],
    status: 'collecting',
    revision: 0,
    executionReceipt: null,
    updatedAt: Date.now(),
  };
  const result = deps.dialogueSessions.set(key, session, expectedRevision);
  if (!result.ok) return { kind: 'race_lost' };
  if (question) {
    await sendQuestion(ctx, question.field);
    return { kind: 'asked' };
  }
  return { kind: 'nothing_to_ask' };
}
