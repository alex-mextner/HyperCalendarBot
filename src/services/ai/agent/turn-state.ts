// The mutable state and wiring one agent turn shares between its phases: the round loop, the
// final-response validation, and the delivery that closes the turn.
import type { WeekdayDateMismatch } from '../day-references.ts';
import type { AgentTermination } from '../request-metrics.ts';
import type { aiStreamRound } from '../streaming.ts';
import type { MessageParam } from './message-sanitizer.ts';
import type { RetryOutcome } from './retry-store.ts';
import type { ValidationRetryEnv } from './validation-retry.ts';

export interface TurnState {
  /** The conversation the next model round is asked to continue. */
  currentMessages: MessageParam[];
  termination: AgentTermination;
  /**
   * Last text-only assistant turn — buffered so a tool-less hallucination is not persisted to
   * chat_history before the validator has a chance to reject it.
   */
  pendingAssistantTurn: MessageParam | null;
  pendingResponseText: string;
  /**
   * A reply that paired a weekday with a date on another weekday gets one corrective round;
   * if the corrected reply still does, the user gets the real weekdays instead of it.
   */
  weekdaysCorrected: boolean;
  unresolvedWeekdays: WeekdayDateMismatch[];
  /** Stays set until a validation retry produces an explicitly approved answer. */
  responseUnverified: boolean;
  /** Assistant prose held back until the final guard can reconcile it with execution evidence. */
  pendingHistory: MessageParam[];
}

export function createTurnState(): TurnState {
  return {
    currentMessages: [],
    termination: 'limit',
    pendingAssistantTurn: null,
    pendingResponseText: '',
    weekdaysCorrected: false,
    unresolvedWeekdays: [],
    responseUnverified: false,
    pendingHistory: [],
  };
}

/** What a failed turn needs to close with: the error and what became of its retry. */
export interface RunFailure {
  failed: boolean;
  error: unknown;
  retry: RetryOutcome;
}

export interface TurnEnv extends ValidationRetryEnv {
  /** Aborts on the overall request deadline or a shutdown. */
  requestSignal: AbortSignal;
  agentStream: typeof aiStreamRound;
  validatorStream: typeof aiStreamRound;
}
