// Protocol constants and defaults shared by the service, the HTTP route and the admin CLI.

/** Every route of the learning protocol lives under this fixed, versioned prefix. */
export const INTENT_LEARNING_ROUTE_PREFIX = '/admin/intent-learning/v1';

/** Version of the generation/review instructions the worker is expected to follow. */
export const INSTRUCTIONS_VERSION = 'intent-learning-2026-09-19-quality-v2';

/** Model and permission mode the worker must run each stage with. */
export const WORKER_MODEL = 'claude-opus-5';
export const WORKER_PERMISSION_MODE = 'auto';

/** Sidecar next to the main database: `<DATABASE_PATH>.intent-learning.sqlite`. */
export const SIDECAR_SUFFIX = '.intent-learning.sqlite';

export function sidecarPathFor(databasePath: string): string {
  return `${databasePath}${SIDECAR_SUFFIX}`;
}

export interface IntentLearningLimits {
  /** Leases that may be held at the same time across all workers. */
  maxConcurrentLeases: number;
  startsPerMinute: number;
  startsPerHour: number;
  startsPerDay: number;
  /** Lease length; every heartbeat extends it by the same amount. */
  leaseMs: number;
  /** A single lease is never extended past this age, heartbeats or not. */
  maxLeaseLifetimeMs: number;
  /** Generation rounds (generate → verify) before the job needs an admin revision. */
  maxGenerationRounds: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Samples attached to one job (eligible and evidence together). */
  maxSamplesPerJob: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_LIMITS: IntentLearningLimits = {
  maxConcurrentLeases: 1,
  startsPerMinute: 2,
  startsPerHour: 12,
  startsPerDay: 48,
  leaseMs: 15 * MINUTE,
  maxLeaseLifetimeMs: 2 * HOUR,
  maxGenerationRounds: 3,
  backoffMinMs: 15 * MINUTE,
  backoffMaxMs: 12 * HOUR,
  maxSamplesPerJob: 24,
};

/** Proposal bounds: operations per proposal and draft rules across all operations. */
export const PROPOSAL_LIMITS = {
  operations: 16,
  rules: 32,
  phrases: 32,
  triggerWords: 32,
  patternChars: 8192,
} as const;

/** Maximum request body accepted by the HTTP route. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Minimum length of either bearer token; shorter tokens leave the route disabled. */
export const MIN_TOKEN_CHARS = 32;

/** Workflow sessions younger than this protect the intents they reference from activation. */
export const ACTIVE_SESSION_WINDOW_MS = 5 * MINUTE;
