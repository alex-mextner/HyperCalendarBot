// Runs a matched intent for a message that has no Telegram context: scheduled messages, triggers
// and retries processed by SyntheticPipelineRunner (src/worker/ai-messages-queue.ts), wired in
// src/index.ts. `{ handled: false }` hands the message to the AI agent. Tools go through the same
// rule guard as the message pipeline, so a run whose rule changed, or whose registry fails its
// integrity check, stops before its next tool call.
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../ai/types.ts';
import type { IntentExecutor } from './intent-executor.ts';
import type { IntentMatcher } from './intent-matcher.ts';
import { evidenceMessage, guardRuleTools } from './rule-run-guard.ts';
import { type Workflow, WorkflowSchema } from './workflow-schema.ts';

export interface SyntheticIntentDeps {
  matcher: Pick<IntentMatcher, 'match'>;
  intentRepo: IntentRepository | undefined;
  executor: Pick<IntentExecutor, 'run'>;
  executeTool: (ctx: AgentContext, toolName: string, input: unknown) => ToolResult | Promise<ToolResult>;
}

const WorkflowCodec = jsonCodec(WorkflowSchema);

export async function runSyntheticIntent(
  deps: SyntheticIntentDeps,
  agentCtx: AgentContext,
  message: string,
): Promise<{ handled: boolean; response?: string }> {
  const { intentRepo } = deps;
  if (!intentRepo) return { handled: false };
  const match = deps.matcher.match(message);
  if (!match) return { handled: false };
  const intent = intentRepo.getById(match.intentId);
  if (!intent) return { handled: false };
  const workflowResult = WorkflowCodec.safeParse(intent.workflow);
  if (!workflowResult.success) return { handled: false };
  const workflow: Workflow = workflowResult.data;
  const fingerprint = intentRepo.runnableFingerprint(intent);
  const userId = agentCtx.user.telegram_id;
  if (fingerprint === null) {
    cmdLogger.warn({ intentId: match.intentId, userId }, 'Synthetic intent rule is no longer runnable, skipping');
    return { handled: false };
  }
  const guard = guardRuleTools(intentRepo, match.intentId, fingerprint, (toolName, input) =>
    deps.executeTool(agentCtx, toolName, input),
  );
  const userCtx = {
    workflowInteraction: 'unavailable' as const,
    userId,
    language: agentCtx.user.language,
    timezone: agentCtx.user.timezone,
    username: agentCtx.user.username ?? undefined,
    firstName: agentCtx.user.first_name ?? undefined,
  };
  const result = await deps.executor.run(workflow, match.captures, userCtx, guard.run);
  // A stop with no write is safe to hand to the agent, which answers from the current catalogue.
  const stopped = guard.changed();
  if (stopped) {
    const evidence = result.mutationEvidence;
    cmdLogger.warn({ intentId: match.intentId, userId, evidence }, 'Synthetic intent run stopped: its rule changed');
    if (evidence !== 'applied' && evidence !== 'unknown') return { handled: false };
  }
  const response = stopped ? evidenceMessage(agentCtx.user.language, result.mutationEvidence) : result.response;
  if (response && agentCtx.sender) {
    await agentCtx.sender.sendMessage(userId, response);
  }
  return { handled: true, response };
}
