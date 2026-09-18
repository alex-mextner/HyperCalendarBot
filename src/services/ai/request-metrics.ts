import type { StreamRoundMetrics } from './streaming.ts';

export type AgentTermination = 'normal' | 'waiting' | 'stop' | 'limit' | 'error' | 'unverified' | 'silent';
export type DeliveryOutcome = 'delivered' | 'fallback' | 'discarded';

export interface AgentRequestMetricSnapshot {
  requestId: string;
  elapsedMs: number;
  firstVisibleMs: number | null;
  modelDurationMs: number;
  toolDurationMs: number;
  deliveryActionMs: number;
  modelCalls: number;
  modelAttempts: number;
  providerFallbacks: number;
  promptTokens: number;
  completionTokens: number;
  reportedTotalTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  usageMissingRounds: number;
  usagePartialRounds: number;
  termination: AgentTermination;
  deliveryOutcome: DeliveryOutcome;
}

const elapsed = (start: number): number => Math.max(0, performance.now() - start);
export class AgentRequestMetrics {
  readonly requestId = crypto.randomUUID();
  readonly startedAt = performance.now();
  private firstVisible: number | null = null;
  private modelDuration = 0;
  private toolDuration = 0;
  private modelCalls = 0;
  private modelAttempts = 0;
  private providerFallbacks = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private reportedTotalTokens = 0;
  private reasoningTokens = 0;
  private cachedTokens = 0;
  private usageMissingRounds = 0;
  private usagePartialRounds = 0;

  markVisible(): void {
    if (this.firstVisible === null) this.firstVisible = elapsed(this.startedAt);
  }

  recordRound(metrics: StreamRoundMetrics | undefined): void {
    this.modelCalls++;
    if (!metrics) {
      this.usageMissingRounds++;
      return;
    }
    this.modelDuration += metrics.totalDurationMs;
    this.modelAttempts += metrics.attemptCount;
    this.providerFallbacks += metrics.fallbackCount;
    if (!metrics.usage) {
      this.usageMissingRounds++;
      return;
    }
    const usage = metrics.usage;
    if (
      usage.promptTokens === null ||
      usage.completionTokens === null ||
      usage.totalTokens === null ||
      usage.reasoningTokens === null ||
      usage.cachedTokens === null
    ) {
      this.usagePartialRounds++;
    }
    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.reportedTotalTokens += usage.totalTokens ?? 0;
    this.reasoningTokens += usage.reasoningTokens ?? 0;
    this.cachedTokens += usage.cachedTokens ?? 0;
  }

  recordFailedRound(durationMs: number, attempts: number, fallbacks: number): void {
    this.modelCalls++;
    this.modelDuration += durationMs;
    this.modelAttempts += attempts;
    this.providerFallbacks += fallbacks;
    this.usageMissingRounds++;
  }

  recordTool(durationMs: number): void {
    this.toolDuration += durationMs;
  }
  snapshot(
    termination: AgentTermination,
    deliveryOutcome: DeliveryOutcome,
    deliveryActionMs: number,
  ): AgentRequestMetricSnapshot {
    return {
      requestId: this.requestId,
      elapsedMs: elapsed(this.startedAt),
      firstVisibleMs: this.firstVisible,
      modelDurationMs: Math.round(this.modelDuration),
      toolDurationMs: Math.round(this.toolDuration),
      deliveryActionMs: Math.round(deliveryActionMs),
      modelCalls: this.modelCalls,
      modelAttempts: this.modelAttempts,
      providerFallbacks: this.providerFallbacks,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      reportedTotalTokens: this.reportedTotalTokens,
      reasoningTokens: this.reasoningTokens,
      cachedTokens: this.cachedTokens,
      usageMissingRounds: this.usageMissingRounds,
      usagePartialRounds: this.usagePartialRounds,
      termination,
      deliveryOutcome,
    };
  }
}

export function elapsedMs(startedAt: number): number {
  return elapsed(startedAt);
}
