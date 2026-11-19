import type { DeliveryOutcome, DeliveryReport } from './delivery-report.ts';
import type { StreamRoundMetrics } from './streaming.ts';

export type AgentTermination = 'normal' | 'waiting' | 'stop' | 'limit' | 'error' | 'unverified' | 'silent';
export type { DeliveryOutcome };

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
  cachedTokens: number | null;
  freshInputTokens: number | null;
  cacheWriteTokens: number | null;
  cachedTokensMissingRounds: number;
  usageMissingRounds: number;
  usagePartialRounds: number;
  termination: AgentTermination;
  deliveryOutcome: DeliveryOutcome;
  /** How many Telegram messages the delivery created or edited, as the API reported them. */
  deliveredMessageCount: number;
  /** Their ids (no text, no user ids); empty when none is known. */
  deliveredMessageIds: number[];
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
  private cachedTokenReports = 0;
  private freshInputTokens = 0;
  private freshInputReports = 0;
  private cacheWriteTokens = 0;
  private cacheWriteReports = 0;
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
    if (usage.cachedTokens !== null) {
      this.cachedTokens += usage.cachedTokens;
      this.cachedTokenReports++;
    }
    if (typeof usage.freshInputTokens === 'number') {
      this.freshInputTokens += usage.freshInputTokens;
      this.freshInputReports++;
    }
    if (typeof usage.cacheWriteTokens === 'number') {
      this.cacheWriteTokens += usage.cacheWriteTokens;
      this.cacheWriteReports++;
    }
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
    delivery: DeliveryReport,
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
      cachedTokens: this.cachedTokenReports ? this.cachedTokens : null,
      freshInputTokens: this.freshInputReports ? this.freshInputTokens : null,
      cacheWriteTokens: this.cacheWriteReports ? this.cacheWriteTokens : null,
      cachedTokensMissingRounds: this.modelCalls - this.cachedTokenReports,
      usageMissingRounds: this.usageMissingRounds,
      usagePartialRounds: this.usagePartialRounds,
      termination,
      deliveryOutcome: delivery.outcome,
      deliveredMessageCount: delivery.messageIds.length,
      deliveredMessageIds: [...delivery.messageIds],
    };
  }
}

export function elapsedMs(startedAt: number): number {
  return elapsed(startedAt);
}
