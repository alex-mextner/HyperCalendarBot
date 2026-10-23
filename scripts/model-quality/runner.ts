// scripts/model-quality/runner.ts
// One scenario for one candidate in one role. The provider call is injected (`RoundFn`), so the loop,
// the grading and the spend accounting are tested offline; run.ts hands it the real production slot.
//
// executor: the agent's main tool loop (system prompt, user message, tools).
// repair:   the round after the answer validator rejected a draft: same transcript plus the rejected
//           draft and the exact retry nudge production sends. The draft is a fixed, unsupported claim.
// A failed or uncertain call is recorded and never replayed; writes only run in the sandbox.

import OpenAI from 'openai';
import { z } from 'zod';
import type { ModelRole } from '../../src/services/ai/model-presets.ts';
import { REPAIR_RETRY_NUDGE } from '../../src/services/ai/repair-nudge.ts';
import {
  EmptyProviderResponseError,
  ProviderSafetyStopError,
  type StreamRoundResult,
} from '../../src/services/ai/streaming.ts';
import { type Budget, BudgetExceededError, estimateRequestUsd, type Reservation } from './budget.ts';
import { type Call, evaluate, type Fixture, type Trace, type Verdict } from './core.ts';
import { type Candidate, candidateId } from './models.ts';
import { createRequestCatalog } from './request-profile.ts';
import { createSandbox, promptFor, tools } from './sandbox.ts';
import type { RoundFn } from './slot.ts';

export type CatalogMode = 'full' | 'lazy';
export type ScenarioRole = Extract<ModelRole, 'executor' | 'repair'>;

export interface RunLimits {
  maxRounds: number;
  /** Wall time for the whole scenario, all rounds included. */
  scenarioDeadlineMs: number;
  /** Wall time for one HTTP attempt. */
  attemptTimeoutMs: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxRounds: 6, scenarioDeadlineMs: 60_000, attemptTimeoutMs: 30_000 };

export type CostSource = 'reported' | 'list-estimate' | 'unknown';

/** What every measured row carries, whatever the role, so one report reads them all. */
export interface MeasuredRow {
  role: ModelRole;
  candidate: string;
  presetId: string;
  provider: string;
  model: string;
  caseId: string;
  /** Scenario family, or the light-case kind for the planner. */
  family: string;
  repetition: number;
  pass: boolean;
  critical: boolean;
  reasons: string[];
  durationMs: number;
  error: string | null;
  errorDetail?: string;
  status: number | null;
  rounds: number;
  /** Wall time of each provider round that returned. */
  roundMs: number[];
  finishReasons: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  usageMissing: boolean;
  /**
   * Cost of the rounds whose usage arrived: provider-reported when present, else list-price estimate,
   * null when none arrived: never 0 for unknown. `usageMissing` marks a row whose total is a lower bound.
   */
  costUsd: number | null;
  costSource: CostSource;
  /** Reserved USD kept because a call's usage never arrived. */
  unknownCostReservationUsd: number;
}

export interface ScenarioRow extends MeasuredRow, Omit<Trace, 'usageMissing'> {
  role: ScenarioRole;
}

const objectSchema = z.record(z.string(), z.json());

/** The fixed rejected draft of the repair role: a completion claim with no tool call behind it. */
export function rejectedDraft(fixture: Fixture): string {
  return (fixture.language ?? 'ru') === 'en' ? 'Done, everything is handled.' : 'Готово, всё выполнено.';
}

export function initialMessages(
  role: ScenarioRole,
  fixture: Fixture,
  catalogPrompt: string,
): OpenAI.ChatCompletionMessageParam[] {
  const base: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: promptFor(fixture) + (catalogPrompt ? `\n\n${catalogPrompt}` : '') },
    { role: 'user', content: fixture.user },
  ];
  if (role === 'executor') return base;
  return [
    ...base,
    { role: 'assistant', content: rejectedDraft(fixture) },
    { role: 'user', content: REPAIR_RETRY_NUDGE },
  ];
}

/** Error text kept in a row: a bounded type or status only, because error bodies can echo inputs and keys. */
export function classifyError(error: unknown): { error: string; status: number | null; detail?: string } {
  if (error instanceof BudgetExceededError) return { error: 'EXPERIMENT_BUDGET', status: null };
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? null;
    return {
      error: status === null ? error.name : `HTTP_${status}`,
      status,
      detail: error.message.slice(0, 300),
    };
  }
  if (error instanceof EmptyProviderResponseError)
    return { error: `EMPTY_${error.diagnostics?.classification ?? 'unknown'}`, status: null };
  if (error instanceof ProviderSafetyStopError) return { error: 'SAFETY_STOP', status: null };
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
    return { error: 'TIMEOUT', status: null };
  if (error instanceof Error) return { error: error.message.slice(0, 120), status: null };
  return { error: 'UNKNOWN_ERROR', status: null };
}

export function costOf(
  usage: { promptTokens: number | null; completionTokens: number | null; costUsd?: number | null } | null,
  price: Candidate['price'],
): { usd: number | null; source: CostSource } {
  if (!usage) return { usd: null, source: 'unknown' };
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd))
    return { usd: usage.costUsd, source: 'reported' };
  if (usage.promptTokens === null || usage.completionTokens === null) return { usd: null, source: 'unknown' };
  return {
    usd: (usage.promptTokens * price.inputUsdPerMTok + usage.completionTokens * price.outputUsdPerMTok) / 1e6,
    source: 'list-estimate',
  };
}

function add(total: number | null, value: number | null): number | null {
  return value === null ? total : (total ?? 0) + value;
}

export interface ScenarioArgs {
  candidate: Candidate;
  fixture: Fixture;
  role: ScenarioRole;
  repetition: number;
  round: RoundFn;
  budget: Budget;
  mode?: CatalogMode;
  limits?: RunLimits;
}

export async function runScenario(args: ScenarioArgs): Promise<ScenarioRow> {
  const { candidate, fixture, role, repetition, round, budget } = args;
  const limits = args.limits ?? DEFAULT_LIMITS;
  const catalog = createRequestCatalog(args.mode ?? 'full', tools);
  const messages = initialMessages(role, fixture, catalog.prompt);
  const sandbox = createSandbox(fixture);
  const row: ScenarioRow = {
    role,
    candidate: candidateId(candidate),
    presetId: candidate.preset.id,
    provider: candidate.provider,
    model: candidate.model,
    caseId: fixture.id,
    family: fixture.family,
    repetition,
    calls: [],
    text: '',
    incomplete: true,
    pass: false,
    critical: false,
    reasons: [],
    durationMs: 0,
    error: null,
    status: null,
    rounds: 0,
    roundMs: [],
    finishReasons: [],
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    usageMissing: false,
    costUsd: null,
    costSource: 'unknown',
    unknownCostReservationUsd: 0,
  };
  const started = performance.now();
  const deadline = Date.now() + limits.scenarioDeadlineMs;
  let pending: Reservation | null = null;
  try {
    for (let n = 0; n < limits.maxRounds; n++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('SCENARIO_DEADLINE');
      const exposed = catalog.exposure?.snapshot();
      pending = budget.reserve(estimateRequestUsd(candidate.price, messages, catalog.schemas()));
      row.rounds++;
      const roundStarted = performance.now();
      const result: StreamRoundResult = await round({
        messages,
        tools: catalog.schemas(),
        signal: AbortSignal.timeout(Math.max(1, Math.min(limits.attemptTimeoutMs, left))),
      });
      row.roundMs.push(performance.now() - roundStarted);
      const usage = result.metrics?.usage ?? null;
      const cost = costOf(usage, candidate.price);
      const reserved = pending;
      budget.settle(reserved, cost.usd);
      pending = null;
      if (cost.usd === null) {
        row.usageMissing = true;
        row.unknownCostReservationUsd += reserved.usd;
      } else {
        row.costUsd = add(row.costUsd, cost.usd);
        row.costSource = row.costSource === 'unknown' || row.costSource === cost.source ? cost.source : 'list-estimate';
      }
      row.inputTokens = add(row.inputTokens, usage?.promptTokens ?? null);
      row.outputTokens = add(row.outputTokens, usage?.completionTokens ?? null);
      row.reasoningTokens = add(row.reasoningTokens, usage?.reasoningTokens ?? null);
      row.cachedTokens = add(row.cachedTokens, usage?.cachedTokens ?? null);
      row.finishReasons.push(result.finishReason);
      if (!result.toolCalls.length) {
        row.text = result.text;
        if (!row.text.trim()) throw new Error(`EMPTY_${result.finishReason}`);
        row.incomplete = result.finishReason === 'length';
        break;
      }
      if (result.finishReason === 'length') throw new Error('TRUNCATED_TOOL_BATCH');
      const parsed = result.toolCalls.map((call) => ({
        ...call,
        args: objectSchema.parse(JSON.parse(call.arguments)),
      }));
      messages.push(result.assistantMessage);
      let wait = false;
      for (const call of parsed) {
        if (wait) {
          row.calls.push({ name: call.name, args: call.args, success: false, error: 'AFTER_WAIT' });
          continue;
        }
        const intercepted = exposed ? catalog.exposure?.intercept(call.name, call.args, exposed) : undefined;
        const executed = intercepted
          ? {
              call: { name: call.name, args: call.args, success: intercepted.success } satisfies Call,
              result: JSON.parse(JSON.stringify(intercepted)),
              wait: false,
            }
          : sandbox.execute(call.name, call.args);
        row.calls.push(executed.call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executed.result) });
        wait = executed.wait;
      }
      const preliminary = evaluate(fixture, { ...row, incomplete: false, error: null });
      if (wait || preliminary.critical) {
        row.incomplete = false;
        break;
      }
    }
  } catch (error) {
    const classified = classifyError(error);
    row.error = classified.error;
    row.status = classified.status;
    if (classified.detail) row.errorDetail = classified.detail;
    if (pending) {
      budget.settle(pending, null);
      row.usageMissing = true;
      row.unknownCostReservationUsd = pending.usd;
    }
  }
  row.durationMs = performance.now() - started;
  const verdict: Verdict = evaluate(fixture, row);
  return Object.assign(row, verdict);
}
