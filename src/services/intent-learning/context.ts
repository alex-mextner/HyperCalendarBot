import type { Database } from 'bun:sqlite';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { CanonicalSeed } from '../intent/seed-replacement.ts';
import type { IntentLearningLimits } from './constants.ts';

/** Everything the learning modules share; built once by the service. */
export interface LearningContext {
  /** The sidecar: queue, artifacts, proposals, ledger, rate bucket, audit, outbox. */
  store: Database;
  /** The main calendar database holding the active intents and the basis manifest. */
  mainDb: Database;
  intentRepo: IntentRepository;
  limits: IntentLearningLimits;
  now: () => number;
  /** Uniform [0, 1) source for backoff jitter; injectable for deterministic tests. */
  random: () => number;
  sourceSeed: readonly CanonicalSeed[];
  /** Only this Telegram user may approve from chat; null disables chat approval. */
  adminId: number | null;
}

export type IntentLearningErrorCode =
  | 'not_found'
  | 'stale_lease'
  | 'reused_session'
  | 'invalid_artifact'
  | 'wrong_stage'
  | 'hash_mismatch'
  | 'invalid_state'
  | 'forbidden'
  | 'validation_failed'
  | 'registry_unavailable'
  | 'activation_refused';

const STATUS: Record<IntentLearningErrorCode, number> = {
  not_found: 404,
  stale_lease: 409,
  reused_session: 409,
  invalid_artifact: 422,
  wrong_stage: 409,
  hash_mismatch: 409,
  invalid_state: 409,
  forbidden: 403,
  validation_failed: 422,
  registry_unavailable: 503,
  activation_refused: 409,
};

/** Typed failure; the HTTP route maps `code` to a status and never leaks internals. */
export class IntentLearningError extends Error {
  readonly status: number;
  constructor(
    readonly code: IntentLearningErrorCode,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'IntentLearningError';
    this.status = STATUS[code];
  }
}
