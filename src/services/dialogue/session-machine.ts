// src/services/dialogue/session-machine.ts
//
// Adaptive question ordering, readiness/confirmation policy, and the exact keyboard-button
// contracts for GH-652's dialogue runtime — pure functions over a DialogueV3Session/draft, no
// I/O. `src/bot/commands/add.ts` and the natural-text pipeline layer both drive a session
// through these functions rather than each inventing its own "what do I ask next" logic.

import type { WallTimeResolution } from '../calendar/wall-time-adapters.ts';
import type { OperationFieldKind } from '../operations/registry.ts';
import type { FuzzyPersonMention } from './full-field-parser.ts';
import type { EventCreateDraft, Question } from './v3-types.ts';

/**
 * A time-only prompt's exact button set (brief: "NEVER Today/Tomorrow on a time-only
 * prompt" — those are DATE answers, not time-of-day ones, and offering them here would let a
 * reply resolve a field this question never asked about).
 */
export const TIME_QUESTION_BUTTONS = ['all_day', 'change_date', 'back', 'cancel'] as const;

function questionForField(field: string, kind: OperationFieldKind): Question {
  return { field, kind, buttons: kind === 'schedule' ? TIME_QUESTION_BUTTONS : [] };
}

/**
 * Adaptive order: only ask a still-missing HARD-required field (title, then schedule).
 * People/place/description/recurrence are never auto-asked here — design §6/§9/§23 removed the
 * implied "people right after time" ordering; a caller offers a visible "Add people"/"Add
 * place" action instead of a forced question.
 */
export function nextQuestion(draft: EventCreateDraft): Question | null {
  if (!draft.title) return questionForField('title', 'title');
  if (!draft.schedule) return questionForField('schedule', 'schedule');
  return null;
}

export type ReadinessBlocker =
  | { readonly kind: 'missing_title' }
  | { readonly kind: 'missing_schedule' }
  | { readonly kind: 'unconfirmed_person'; readonly rawName: string }
  /** An explicit "не"/"not"/"don't" marker was seen in a turn that fed this draft — a negated request must never quietly execute as if the negation were not there (blocker: parseResult.negated MUST block event.create). */
  | { readonly kind: 'negated' }
  /** A name was explicitly stated but matched no contact at all — dropping it silently would create the event without someone the user named (blocker: unresolvedPeopleNames MUST block event.create). */
  | { readonly kind: 'unresolved_person'; readonly rawName: string };

export interface ReadinessCheck {
  readonly ready: boolean;
  readonly blockedBy: readonly ReadinessBlocker[];
}

export interface ReadinessInput {
  /** Names mentioned this turn that still need an explicit yes/no before being added. */
  readonly fuzzyPeople: readonly FuzzyPersonMention[];
  /** `parseFullField`'s negation marker for the turn that produced (or last touched) this draft. */
  readonly negated: boolean;
  /** Names mentioned this turn that matched no contact at all. */
  readonly unresolvedPeopleNames: readonly string[];
}

/**
 * Whether a draft can execute right now with no further question. A fully specified explicit
 * request executes once, with no redundant confirmation the legacy wizard used to always ask —
 * but an unconfirmed fuzzy person, an unresolved explicit name, or a negation marker still
 * blocks (design: "a single fuzzy contact match ... requires explicit confirmation", never
 * bypassed just because the rest of the draft is done; a negated or partially-unresolved
 * explicit request must never silently execute as if it were complete).
 */
export function checkReadiness(draft: EventCreateDraft, input: ReadinessInput): ReadinessCheck {
  const blockedBy: ReadinessBlocker[] = [];
  if (!draft.title) blockedBy.push({ kind: 'missing_title' });
  if (!draft.schedule) blockedBy.push({ kind: 'missing_schedule' });
  if (input.negated) blockedBy.push({ kind: 'negated' });
  for (const fuzzy of input.fuzzyPeople) blockedBy.push({ kind: 'unconfirmed_person', rawName: fuzzy.rawName });
  for (const rawName of input.unresolvedPeopleNames) blockedBy.push({ kind: 'unresolved_person', rawName });
  return { ready: blockedBy.length === 0, blockedBy };
}

export interface TimeChoiceButton {
  readonly value: string;
  readonly label: string;
}

/**
 * The exact "02:00 (night) / 14:00 (day)" button pair for a bare-hour reply like "2" — built
 * from the shared parser's own candidates (wall-time-parser.ts's `bareHourCandidates`: low
 * hour first, +12h second), never re-derived independently so the two can never disagree.
 */
export function bareHourButtons(candidates: readonly [string, string]): readonly [TimeChoiceButton, TimeChoiceButton] {
  const [low, high] = candidates;
  return [
    { value: low, label: `${low} (night)` },
    { value: high, label: `${high} (day)` },
  ];
}

/**
 * A user's tap on a bare-hour/DST-fold candidate button is re-validated through the same
 * shared parser as any typed input — never trusted as a pre-resolved instant — so a session
 * whose timezone changed between question and answer (or a candidate landing in a DST gap,
 * per wall-time-parser.test.ts's own documented scope boundary) is caught, not silently
 * accepted.
 */
export function revalidateChosenTime(
  candidateValue: string,
  ctx: { selectedDate: string; timezone: string },
  resolveWallTime: (raw: string, ctx: { selectedDate: string; timezone: string }) => WallTimeResolution,
): WallTimeResolution {
  return resolveWallTime(candidateValue, ctx);
}
