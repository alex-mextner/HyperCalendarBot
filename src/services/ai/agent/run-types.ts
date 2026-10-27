// Result types of one agent run, as seen by the pipeline, worker and tests.
import type { AgentRequestMetricSnapshot } from '../request-metrics.ts';

export interface AgentToolCallRecord {
  name: string;
  input: { [key: string]: unknown };
}

export interface AgentToolResultRecord {
  success: boolean;
  output?: string;
}

export interface AgentRunResult {
  responseText: string;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
  endCall?: boolean;
  /** Structured latency/cost telemetry; contains no user text, tool args or actor ids. */
  metrics?: AgentRequestMetricSnapshot;
}
