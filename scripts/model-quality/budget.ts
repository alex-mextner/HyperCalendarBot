// scripts/model-quality/budget.ts
// Spend envelope for a live run. Every request reserves an upper bound BEFORE it is sent; a call that
// reports its cost settles the difference, a call whose usage never arrived keeps the whole reservation
// (an unknown cost is never counted as free). The cap cannot be raised from the command line.

import type OpenAI from 'openai';
import type { TokenPrice } from '../../src/services/ai/model-presets.ts';

/** Owner-approved ceiling for the whole B5 measurement run, in USD. */
export const TOTAL_BUDGET_CAP_USD = 3;

/**
 * Output tokens one attempt can bill: the per-attempt deadline (30 s) bounds hidden reasoning, so the
 * reserve is a realistic ceiling, not a model's 128k server cap.
 */
export const OUTPUT_RESERVE_TOKENS = 16_384;

export class BudgetExceededError extends Error {
  constructor(
    readonly needUsd: number,
    readonly leftUsd: number,
  ) {
    super('EXPERIMENT_BUDGET');
    this.name = 'BudgetExceededError';
  }
}

export interface Reservation {
  usd: number;
  settled: boolean;
}

export class Budget {
  private spent = 0;
  private unknown = 0;

  /**
   * @param capUsd this invocation's cap
   * @param alreadySpentUsd what earlier invocations of the same run already spent
   */
  readonly capUsd: number;

  constructor(capUsd: number, alreadySpentUsd = 0) {
    if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > TOTAL_BUDGET_CAP_USD) throw new Error('Invalid budget');
    if (!Number.isFinite(alreadySpentUsd) || alreadySpentUsd < 0) throw new Error('Invalid already-spent amount');
    if (capUsd + alreadySpentUsd > TOTAL_BUDGET_CAP_USD) throw new Error('Budget exceeds the run-wide cap');
    this.capUsd = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get unknownReservations(): number {
    return this.unknown;
  }

  reserve(usd: number): Reservation {
    if (!Number.isFinite(usd) || usd < 0) throw new Error('Invalid reservation');
    if (this.spent + usd > this.capUsd) throw new BudgetExceededError(usd, this.capUsd - this.spent);
    this.spent += usd;
    return { usd, settled: false };
  }

  /** `actualUsd` null: the cost is unknown, so the reservation stays counted in full. */
  settle(reservation: Reservation, actualUsd: number | null): void {
    if (reservation.settled) throw new Error('Reservation already settled');
    reservation.settled = true;
    if (actualUsd === null) {
      this.unknown++;
      return;
    }
    this.spent += actualUsd - reservation.usd;
  }
}

/** Upper bound of one request: UTF-8 bytes of the transcript and tools over two as input tokens, plus the output reserve. */
export function estimateRequestUsd(
  price: TokenPrice,
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionTool[],
): number {
  const bytes =
    new TextEncoder().encode(JSON.stringify(messages)).length + new TextEncoder().encode(JSON.stringify(tools)).length;
  return ((bytes / 2) * price.inputUsdPerMTok + OUTPUT_RESERVE_TOKENS * price.outputUsdPerMTok) / 1e6;
}
