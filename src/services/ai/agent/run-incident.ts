// An agent run that ends badly for the user (error, unverified answer, spent rounds, "request
// interrupted" notice) is reported once to the owner's alert queue, so the unattended investigation
// that already handles crashes and outages also sees it. /health and /ready stay green for such runs.
//
// The report carries only identifiers of the run and counts: never the user's message, history,
// answers, event titles or chat/user ids. The investigator finds the run by its requestId in the
// container log and in the per-chat debug log.
import { logger } from '../../../utils/logger.ts';
import type { AgentRequestMetricSnapshot, AgentTermination } from '../request-metrics.ts';
import { isMutationTool } from '../tool-executor.ts';
import { toolSchemas } from '../tool-schemas.ts';
import type { AgentToolCallRecord, AgentToolResultRecord } from './run-types.ts';
import type { RunFailure, TurnState } from './turn-state.ts';

const aiLogger = logger.child({ module: 'agent-run-incident' });

/** The `source` of the alerts table row; the alert watcher recognizes the class by it. */
export const AGENT_RUN_INCIDENT_SOURCE = 'agent-run-incident';
/** At most one alert per class in this window; the rest are only counted. */
export const INCIDENT_WINDOW_MS = 10 * 60_000;

/** error: the run threw; interrupted: the reply says the request was cut short; unverified: the answer could not be checked; limit: rounds ran out. */
export type RunIncidentClass = 'error' | 'unverified' | 'limit' | 'interrupted';

export interface RunIncident {
  incidentClass: RunIncidentClass;
  requestId: string;
  termination: AgentTermination;
  elapsedMs: number;
  deliveryOutcome: AgentRequestMetricSnapshot['deliveryOutcome'];
  /** Telegram message ids the final delivery created or edited. */
  deliveredMessageIds: readonly number[];
  /** Tool names with how many calls succeeded and failed. */
  tools: { name: string; ok: number; failed: number }[];
  /** At least one calendar-changing tool call succeeded. */
  writeSucceeded: boolean;
  modelCalls: number;
  modelAttempts: number;
  providerFallbacks: number;
  /** `not_run`, `approved`, `rejected` or `unavailable(<cause>)`; never the validator's free text. */
  validator: string;
  /** The class name of the error that ended the run, when one did (never its message). */
  errorName: string | null;
}

/** The incident class of a finished run, or null when the run ended as the user expects. */
export function classifyRunIncident(
  state: Pick<TurnState, 'termination'>,
  failure: Pick<RunFailure, 'failed'>,
  plan: { silent: boolean; interrupted: boolean },
  supplementMode: boolean,
): RunIncidentClass | null {
  // A supplement is an optional remark after an answer the user already has; a quiet run shows no notice.
  if (supplementMode || plan.silent) return null;
  if (failure.failed) return 'error';
  if (plan.interrupted) return 'interrupted';
  if (state.termination === 'unverified') return 'unverified';
  if (state.termination === 'limit') return 'limit';
  return null;
}

/** Per-tool success and failure counts, in first-call order. */
export function tallyTools(
  calls: readonly AgentToolCallRecord[],
  results: readonly AgentToolResultRecord[],
): RunIncident['tools'] {
  const tally = new Map<string, { name: string; ok: number; failed: number }>();
  calls.forEach((call, index) => {
    // A model can invent a tool name (text, line breaks): only names the bot defines reach the alert.
    const name = Object.hasOwn(toolSchemas, call.name) ? call.name : 'unknown_tool';
    const entry = tally.get(name) ?? { name, ok: 0, failed: 0 };
    if (results[index]?.success) entry.ok++;
    else entry.failed++;
    tally.set(name, entry);
  });
  return [...tally.values()];
}

export function anyWriteSucceeded(
  calls: readonly AgentToolCallRecord[],
  results: readonly AgentToolResultRecord[],
): boolean {
  return calls.some((call, index) => results[index]?.success === true && isMutationTool(call.name, call.input));
}

export function formatRunIncident(incident: RunIncident, suppressed: number): string {
  const tools = incident.tools.map((tool) => `${tool.name} ok=${tool.ok} fail=${tool.failed}`).join('; ') || 'none';
  return [
    `Agent run incident (${incident.incidentClass})`,
    `requestId: ${incident.requestId}`,
    `termination: ${incident.termination}`,
    `elapsedMs: ${Math.round(incident.elapsedMs)}`,
    `tools: ${tools}`,
    `writeSucceeded: ${incident.writeSucceeded ? 'yes' : 'no'}`,
    `provider: modelCalls=${incident.modelCalls} attempts=${incident.modelAttempts} fallbacks=${incident.providerFallbacks}`,
    `validator: ${incident.validator}`,
    `delivery: ${incident.deliveryOutcome} messages=${incident.deliveredMessageIds.length}${incident.deliveredMessageIds.length ? ` ids=${incident.deliveredMessageIds.join(',')}` : ''}`,
    ...(incident.errorName ? [`error: ${incident.errorName}`] : []),
    ...(suppressed > 0
      ? [`suppressedSince: ${suppressed} earlier incident(s) of this class were not alerted in the last 10 minutes`]
      : []),
    `Look the requestId up: \`docker logs hypercal-bot 2>&1 | grep ${incident.requestId}\` on root@odroidn2, and the per-chat debug log under logs/chats/ (grep its "REQUEST ID:" line).`,
  ].join('\n');
}

/**
 * Pushes run incidents to the alert queue, at most one per class per window with a count of the
 * ones held back in the next. A provider outage ends many runs the same way and is already covered
 * by /ready, so it must not flood the queue.
 */
export class RunIncidentReporter {
  private readonly classes = new Map<RunIncidentClass, { lastPushedAt: number; suppressed: number }>();

  constructor(
    private readonly push: (text: string, source: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  report(incident: RunIncident): void {
    const at = this.now();
    const state = this.classes.get(incident.incidentClass);
    if (state && at - state.lastPushedAt < INCIDENT_WINDOW_MS) {
      state.suppressed++;
      return;
    }
    try {
      this.push(formatRunIncident(incident, state?.suppressed ?? 0), AGENT_RUN_INCIDENT_SOURCE);
      this.classes.set(incident.incidentClass, { lastPushedAt: at, suppressed: 0 });
    } catch (err) {
      // The alert queue is a side channel: failing to reach it must never fail the user's turn.
      aiLogger.error({ err, requestId: incident.requestId }, 'Agent run incident alert could not be queued');
    }
  }
}
