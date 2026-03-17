// src/bot/pipeline/intent-matcher-layer.ts

import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { User } from '../../database/types.ts';
import type { ToolResult } from '../../services/ai/types.ts';
import type { IntentExecutor } from '../../services/intent/intent-executor.ts';
import type { IntentMatcher } from '../../services/intent/intent-matcher.ts';
import { formatResponse } from '../../services/intent/response-formatter.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { BotCommandContext } from '../types.ts';
import type { PipelineResult } from './types.ts';

export interface WorkflowSession {
  intentId: number;
  stepIndex: number;
  stepResults: Record<string, unknown>;
  workflow: Record<string, unknown>;
  captures: Record<string, string>;
  createdAt: number;
}

const WORKFLOW_SESSION_TTL = 5 * 60 * 1000; // 5 minutes

export function createIntentMatcherLayer(
  matcher: IntentMatcher,
  intentRepo: IntentRepository,
  executor: IntentExecutor,
  toolExecutor: (toolName: string, input: Record<string, unknown>) => ToolResult,
  workflowSessions: Map<number, WorkflowSession>,
) {
  return async (ctx: BotCommandContext, messageText: string): Promise<PipelineResult> => {
    const user = ctx.dbUser as User;
    const userId = user.telegram_id;

    // 1. Check for active workflow session (resuming from ask_user)
    const session = workflowSessions.get(userId);
    if (session) {
      workflowSessions.delete(userId);
      if (Date.now() - session.createdAt < WORKFLOW_SESSION_TTL) {
        const result = await executor.run(
          session.workflow,
          session.captures,
          { timezone: user.timezone, language: user.language },
          toolExecutor,
          { stepIndex: session.stepIndex, stepResults: session.stepResults, userAnswer: messageText },
        );
        if (result.response) {
          await ctx.send(result.response);
        }
        return { handled: true };
      }
    }

    // 2. Try matching
    const match = matcher.match(messageText);
    if (!match) return { handled: false };

    // 3. Load workflow from DB
    const intent = intentRepo.getById(match.intentId);
    if (!intent) return { handled: false };

    let workflow: Record<string, unknown>;
    try {
      workflow = JSON.parse(intent.workflow) as Record<string, unknown>;
    } catch {
      cmdLogger.error({ intentId: match.intentId }, 'Intent has invalid workflow JSON, skipping');
      return { handled: false };
    }

    // 4. Execute
    const result = await executor.run(
      workflow,
      match.captures,
      { timezone: user.timezone, language: user.language },
      toolExecutor,
    );

    // 5. Handle suspension
    if (result.suspended && result.suspendedAt !== undefined) {
      workflowSessions.set(userId, {
        intentId: match.intentId,
        stepIndex: result.suspendedAt,
        stepResults: result.stepResults ?? {},
        workflow,
        captures: match.captures,
        createdAt: Date.now(),
      });
      return { handled: true };
    }

    // 6. Format and send response
    if (result.response) {
      const formatted =
        intent.format !== 'text'
          ? formatResponse(intent.format, result.response, user.timezone, user.language)
          : result.response;
      await ctx.send(formatted);
    }

    return { handled: true };
  };
}
