// src/services/dialogue/v3-types.ts
//
// Workflow v3 session shape (GH-652): a typed, adadptive-order draft for one shared operation
// (today only `event.create`, per the registered src/services/operations/registry.ts entry),
// alongside — never replacing — the existing v1 legacy-workflow and v2 typed-workflow sessions
// (src/services/intent/workflow-schema.ts) and the unrelated GramIO scene wizard
// (src/bot/scenes/add-event.scene.ts / AddEventState). See migrations.ts's
// `068_dialogue_v3_sessions` for why this gets its own SQLite table rather than reusing either.

import type { Schedule } from '../calendar/wall-time-parser.ts';
import type { OperationFieldKind } from '../operations/registry.ts';

export interface DraftPerson {
  readonly contactId: number | null;
  readonly telegramId: number | null;
  readonly displayName: string;
  /** false until a fuzzy match is explicitly confirmed by the user (design §23). */
  readonly confirmed: boolean;
}

/**
 * Real invitation-delivery classification for one `executeDraft` attempt (session-runtime.ts's
 * `inviteResolvedPeople`) — durable enough to persist in `ExecutionReceipt.inviteOutcome` so a
 * resumed session can render the exact same honest disclosure a crash prevented from reaching
 * the user the first time, never a re-derived or re-attempted guess.
 */
export interface InviteOutcome {
  /** Bot API or MTProto actually delivered the message to the invitee. */
  readonly delivered: readonly DraftPerson[];
  /** An Invitation record exists, but live delivery failed; a deep-link fallback was sent to the INVITER to forward manually — never claimed as delivered to the invitee. */
  readonly pendingManualForward: readonly DraftPerson[];
  readonly noAccount: readonly DraftPerson[];
  readonly failed: readonly { readonly person: DraftPerson; readonly reason: string }[];
}

export interface DraftPlace {
  readonly kind: 'manual' | 'native';
  readonly label: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface EventCreateDraft {
  title?: string;
  schedule?: Schedule;
  /**
   * Resolved once `schedule.kind === 'timed'` is known — the actual end instant this draft
   * will execute with, computed once (design §6/blocker: "duration/end" is durable draft
   * state, never silently recomputed differently at execute time by a second code path).
   */
  endAt?: string;
  people: DraftPerson[];
  place?: DraftPlace;
  description?: string;
  /** Raw RRULE string, passed through unexamined — GH-657 owns full recurrence semantics. */
  recurrenceRule?: string;
  scope: 'personal' | 'group';
  groupId?: number;
  /** Per-field provenance for every registry field — always present, defaults to 'missing'. */
  provenance: FieldProvenanceMap;
}

/**
 * How a field's current value (if any) came to be, distinct from whether it is SET:
 * - `missing`: never touched.
 * - `supplied`: the user explicitly stated it in some turn's text.
 * - `defaulted`: the runtime filled it in without the user stating it (not currently used by
 *   any field — duration/end is always system-computed today, tracked via `schedule`'s own
 *   provenance rather than a separate axis; kept in the union for a future explicit-duration
 *   input path rather than removed).
 * - `ambiguous`: a value was mentioned but not yet resolved to a single answer (a fuzzy person
 *   match, a bare-hour candidate pair) — distinct from `missing` (something WAS said) and from
 *   `supplied` (it is NOT yet safe to act on).
 * - `cleared`: the user explicitly removed a previously-set value (no UI path sets this today;
 *   kept so a future "remove place"/"remove person" action has a real state to transition to
 *   rather than silently reusing `missing`, which would erase the fact that something was once
 *   supplied and then deliberately taken back out).
 */
export type FieldProvenance = 'missing' | 'defaulted' | 'supplied' | 'ambiguous' | 'cleared';

export type DraftFieldName = 'title' | 'schedule' | 'people' | 'place' | 'description' | 'recurrence';

export type FieldProvenanceMap = Readonly<Record<DraftFieldName, FieldProvenance>>;

export const MISSING_PROVENANCE: FieldProvenanceMap = {
  title: 'missing',
  schedule: 'missing',
  people: 'missing',
  place: 'missing',
  description: 'missing',
  recurrence: 'missing',
};

export function emptyDraft(scope: 'personal' | 'group', groupId?: number): EventCreateDraft {
  return { people: [], scope, groupId, provenance: MISSING_PROVENANCE };
}

/**
 * `executing` sits strictly between `collecting`/`ready` and the terminal `executed`: the
 * session is durably marked `executing` (compare-and-swap, DialogueSessionRepository.set) in
 * the same synchronous stretch as the readiness check, BEFORE `EventService.createEvent` runs,
 * so a second concurrent write for the same session (a duplicate Telegram update, a retried
 * webhook) loses the CAS race and never also executes. If the process crashes between that CAS
 * write and the session being deleted post-creation, the row is left in `executing` with an
 * `executionReceipt.status === 'unknown'` — the runtime must treat that as a dead end (never
 * silently resume or re-execute it) rather than guess whether the event was actually created.
 */
export type DialogueV3Status = 'collecting' | 'ready' | 'executing' | 'executed' | 'cancelled' | 'handed_off';

/**
 * Durable status for one post-create side effect. `pending`: never attempted, safe for a
 * resumed session to run for the first time. `applied`: the attempt ran to completion (its own
 * result — even a locally-known partial failure, e.g. "no linked Telegram account" — was
 * captured and honestly disclosed; there is nothing left to reconcile). `unknown`: the attempt
 * itself threw/rejected, or the process crashed between the pre-attempt marker below and the
 * completion write — for a real network side effect (an invitation send, a Google Calendar
 * push, a Telegram receipt) a caught exception does NOT prove the remote call never landed, so
 * this is never blindly retried, only surfaced for operator/user reconciliation. `failed`:
 * reserved for a caller with a typed, unambiguous non-delivery signal (none of the three
 * effects below produce one today; a future caller with such a signal can use it without a
 * schema change) — resume treats it identically to `unknown` (never retried).
 */
export type EffectStatus = 'pending' | 'applied' | 'unknown' | 'failed';

/**
 * The three durable side effects `executeDraft` still owes after the event itself exists.
 * `invitations`/`postCreateHooks` cover session-runtime.ts's `inviteResolvedPeople`/
 * `runPostCreateHooks`; `receipt` covers `sendReceipt`. A session is deleted only once every
 * field here is `applied` — see `isEffectLedgerReconciled`.
 */
export interface EffectLedger {
  readonly invitations: EffectStatus;
  readonly postCreateHooks: EffectStatus;
  readonly receipt: EffectStatus;
}

/**
 * Durable idempotency identity for the one irreversible transition this session can make
 * (creating the calendar event). `unknown` is written BEFORE the create call; `applied` is
 * written only after `EventService.createEvent` actually returned an event — never inferred,
 * never guessed from an absent error. Once `applied`, `effects` tracks the three durable
 * post-create side effects (see `EffectLedger`) and `inviteOutcome` durably carries the actual
 * invitation-delivery result once known, so a resumed/reconciled session can render the exact
 * same honest receipt a crash prevented from reaching the user, never a re-attempted guess.
 */
export type ExecutionReceipt =
  | { readonly status: 'unknown'; readonly attemptedAtRevision: number }
  | {
      readonly status: 'applied';
      readonly eventId: number;
      readonly appliedAtRevision: number;
      readonly effects: EffectLedger;
      readonly inviteOutcome: InviteOutcome | null;
    };

export function isEffectLedgerReconciled(effects: EffectLedger): boolean {
  return effects.invitations === 'applied' && effects.postCreateHooks === 'applied' && effects.receipt === 'applied';
}

export const PENDING_EFFECT_LEDGER: EffectLedger = {
  invitations: 'pending',
  postCreateHooks: 'pending',
  receipt: 'pending',
};

/**
 * A field the dialogue runtime still needs an answer for. `kind` selects the parser/keyboard;
 * `buttons` is the exact set of quick-reply options a caller should render for that prompt —
 * e.g. a time-only prompt is `['all_day', 'change_date', 'back', 'cancel']`, NEVER
 * `['today', 'tomorrow']` (design brief: a time-only prompt must never offer Today/Tomorrow).
 */
export interface Question {
  readonly field: string;
  readonly kind: OperationFieldKind;
  readonly buttons: readonly string[];
}

/** A partial, provenance-free update to the draft produced by parsing one turn of input. */
export type DraftPatch = Partial<EventCreateDraft>;

export interface PendingPersonCandidate {
  readonly contactId: number;
  readonly telegramId: number | null;
  readonly displayName: string;
  readonly confidence: number;
}

/** A name that matched no contact exactly — parked here, never silently dropped or auto-added, until the user confirms or declines it (design §23). */
export interface PendingFuzzyPerson {
  readonly rawName: string;
  readonly candidates: readonly PendingPersonCandidate[];
}

export interface DialogueV3Session {
  readonly version: 3;
  readonly sessionId: string;
  readonly actorId: number;
  readonly chatId: number;
  readonly topicId: number;
  readonly operation: 'event.create';
  /**
   * The IANA zone this draft is fixed to for its entire lifetime, captured once at session
   * creation — never silently re-read from a mutable user setting mid-draft, so a timezone
   * change between the first and a later turn cannot shift an already-parsed local date/time.
   */
  readonly timezone: string;
  /**
   * The anchor local calendar day (`yyyy-mm-dd`) a bare time-of-day answer resolves against —
   * set from the most recent turn that stated a date phrase, carried forward otherwise (e.g.
   * "Meeting tomorrow" then a bare "14:00" reply must resolve against tomorrow, not the day the
   * reply happened to arrive on).
   */
  readonly selectedDate: string;
  readonly draft: EventCreateDraft;
  readonly pendingField: string | null;
  /**
   * Unconfirmed name mentions awaiting a yes/no from the user, oldest first — a real fuzzy
   * match (`candidates.length > 0`) asks "did you mean X"; a name that matched no contact at
   * all (blocker: unresolvedPeopleNames MUST block event.create) is represented the same way
   * with an empty `candidates` array and asks the user to send a known name or reply "skip"
   * (session-machine.ts's `continueFuzzyConfirmation`-style handler treats an empty-candidate
   * entry's yes/no/skip reply identically — there is no candidate to confirm either way, only
   * "drop this name and continue").
   */
  readonly pendingFuzzyPeople: readonly PendingFuzzyPerson[];
  readonly status: DialogueV3Status;
  /** Monotonic write counter — every DialogueSessionRepository.set() bumps this by exactly 1. */
  readonly revision: number;
  /** Set only once this session reaches (or attempts) the one irreversible transition. */
  readonly executionReceipt: ExecutionReceipt | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The raw text that started this draft, preserved verbatim for the AI handoff receipt. */
  readonly sourceText: string;
}
