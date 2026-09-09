// src/worker/synthetic-intent-runner.ts
//
// Builds the `intentRun` closure used by SyntheticPipelineRunner (src/worker/ai-messages-queue.ts)
// for scheduled/AI-triggered synthetic messages - the codepath that never goes through GramIO's
// live update handler. Extracted from src/index.ts so the formatResponse step (which the live
// intent-matcher-layer.ts pipeline always applies before sending) can be unit tested directly;
// see https://github.com/alex-mextner/HyperCalendarBot/issues/172.

import type { IntentRepository } from '../database/repositories/intent.repository.ts';
import type { AgentContext, ToolResult } from '../services/ai/types.ts';
import type { IntentExecutor } from '../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../services/intent/intent-matcher.ts';
import { formatResponse } from '../services/intent/response-formatter.ts';
import { type Workflow, WorkflowSchema } from '../services/intent/workflow-schema.ts';
import { jsonCodec } from '../utils/json-codec.ts';

const WorkflowCodec = jsonCodec(WorkflowSchema);

export interface SyntheticIntentRunDeps {
  intentMatcher: IntentMatcher;
  intentRepo: IntentRepository | undefined;
  intentExecutor: IntentExecutor;
  executeTool: (agentCtx: AgentContext, toolName: string, input: unknown) => ToolResult | Promise<ToolResult>;
}

/**
 * Matches a synthetic/scheduled message against approved intents, runs the matched workflow,
 * and - mirroring the live intent-matcher-layer.ts pipeline - formats the result via
 * formatResponse() before delivering it. `result.response` is text written for the AI agent
 * (e.g. "id: 239, title: Standup, ..."), never fit to show a user verbatim; formatResponse
 * prefers the structured `result.responseEvents` when present and otherwise renders by
 * `intent.format`, so internal fields never reach the user unformatted.
 */
export function createSyntheticIntentRun(deps: SyntheticIntentRunDeps) {
  return async (agentCtx: AgentContext, message: string): Promise<{ handled: boolean; response?: string }> => {
    const match = deps.intentMatcher.match(message);
    if (!match) return { handled: false };
    const intent = deps.intentRepo?.getById(match.intentId);
    if (!intent) return { handled: false };
    const workflowResult = WorkflowCodec.safeParse(intent.workflow);
    if (!workflowResult.success) return { handled: false };
    const workflow: Workflow = workflowResult.data;
    const userCtx = {
      userId: agentCtx.user.telegram_id,
      language: agentCtx.user.language,
      timezone: agentCtx.user.timezone,
      username: agentCtx.user.username ?? undefined,
      firstName: agentCtx.user.first_name ?? undefined,
    };
    const result = await deps.intentExecutor.run(
      workflow,
      match.captures,
      userCtx,
      (toolName: string, input: unknown) => deps.executeTool(agentCtx, toolName, input),
    );
    if (result.response && agentCtx.sender) {
      const formatted = formatResponse(
        intent.format,
        result.response,
        agentCtx.user.timezone,
        agentCtx.user.language,
        result.responseEvents,
      );
      await agentCtx.sender.sendMessage(agentCtx.user.telegram_id, formatted);
      return { handled: true, response: formatted };
    }
    return { handled: true, response: result.response };
  };
}
