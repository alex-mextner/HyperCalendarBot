// src/services/dialogue/v3-types.ts
//
// Workflow v3 session shape (GH-652): a typed, adadptive-order draft for one shared operation
// (today only `event.create`, per the registered src/services/operations/registry.ts entry),
// alongside — never replacing — the existing v1 legacy-workflow and v2 typed-workflow sessions
// (src/services/intent/workflow-schema.ts) and the unrelated GramIO scene wizard
// (src/bot/scenes/add-event.scene.ts / AddEventState). See migrations.ts's
// `066_dialogue_v3_sessions` for why this gets its own SQLite table rather than reusing either.

import type { Schedule } from '../calendar/wall-time-parser.ts';
import type { OperationFieldKind } from '../operations/registry.ts';

export interface DraftPerson {
  readonly contactId: number | null;
  readonly telegramId: number | null;
  readonly displayName: string;
  /** false until a fuzzy match is explicitly confirmed by the user (design §23). */
  readonly confirmed: boolean;
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
  people: DraftPerson[];
  place?: DraftPlace;
  description?: string;
  /** Raw RRULE string, passed through unexamined — GH-657 owns full recurrence semantics. */
  recurrenceRule?: string;
  scope: 'personal' | 'group';
  groupId?: number;
}

export function emptyDraft(scope: 'personal' | 'group', groupId?: number): EventCreateDraft {
  return { people: [], scope, groupId };
}

export type DialogueV3Status = 'collecting' | 'ready' | 'executed' | 'cancelled' | 'handed_off';

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
  readonly draft: EventCreateDraft;
  readonly pendingField: string | null;
  /** Unconfirmed fuzzy-name matches awaiting a yes/no from the user, oldest first. */
  readonly pendingFuzzyPeople: readonly PendingFuzzyPerson[];
  readonly status: DialogueV3Status;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The raw text that started this draft, preserved verbatim for the AI handoff receipt. */
  readonly sourceText: string;
}
