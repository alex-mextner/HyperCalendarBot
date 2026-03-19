import { cmdLogger } from '../../utils/logger.ts';
import type { ToolResult } from '../ai/types.ts';
import { evaluate } from './expression-evaluator.ts';
import { type UserContext as ExecutorUserContext, resolveVariables } from './variable-resolver.ts';

type ToolExecutorFn = (toolName: string, input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/** Build the initial step-results map pre-populated with event and group context from UserContext. */
function buildEventStepResults(userCtx: ExecutorUserContext): Record<string, unknown> {
  const pre: Record<string, unknown> = {};
  if (userCtx.lastAddedEvent) pre.last_added_event = userCtx.lastAddedEvent;
  if (userCtx.lastMentionedEvent) pre.last_mentioned_event = userCtx.lastMentionedEvent;
  pre.group = {
    is_group: userCtx.groupIsGroup ?? false,
    chat_id: userCtx.groupChatId ?? null,
  };
  return pre;
}

interface ExecutorResult {
  success: boolean;
  response?: string;
  suspended?: boolean;
  suspendedAt?: number;
  stepResults?: Record<string, unknown>;
}

interface ResumeState {
  stepIndex: number;
  stepResults: Record<string, unknown>;
  userAnswer: string;
}

interface Level1Tool {
  name: string;
  input: Record<string, unknown>;
}

interface Level2Step {
  call?: string;
  input?: Record<string, unknown>;
  as?: string;
  when?: string;
  respond?: string;
  stop?: boolean;
}

/**
 * Parse tool output: if valid JSON, return parsed value; otherwise return raw string.
 */
function parseToolOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

/**
 * Execute a Level 1 workflow: { tools: [...], format: "..." }
 */
async function runLevel1(
  tools: Level1Tool[],
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  executeTool: ToolExecutorFn,
): Promise<ExecutorResult> {
  let lastOutput: string | undefined;

  const eventCtx = buildEventStepResults(userCtx);

  for (const tool of tools) {
    const resolvedInput = resolveVariables(tool.input, captures, userCtx, eventCtx) as Record<string, unknown>;
    const result = await executeTool(tool.name, resolvedInput);
    if (!result.success) {
      cmdLogger.warn({ tool: tool.name, error: result.error }, 'Intent L1 tool step failed');
      return { success: false, response: result.error };
    }
    lastOutput = result.output;
  }

  return { success: true, response: lastOutput };
}

/**
 * Execute a Level 2 workflow: { steps: [...] }
 */
async function runLevel2(
  steps: Level2Step[],
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  executeTool: ToolExecutorFn,
  resumeState?: ResumeState,
): Promise<ExecutorResult> {
  const stepResults: Record<string, unknown> = {
    ...buildEventStepResults(userCtx),
    ...(resumeState?.stepResults ?? {}),
  };

  // When resuming, set the user answer for the suspended ask_user step
  let startIndex = 0;
  if (resumeState !== undefined) {
    const suspendedStep = steps[resumeState.stepIndex];
    if (suspendedStep?.as) {
      stepResults[suspendedStep.as] = resumeState.userAnswer;
    }
    startIndex = resumeState.stepIndex + 1;
  }

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];

    // Evaluate `when` condition — skip step if false
    if (step.when !== undefined) {
      const conditionMet = evaluate(step.when, stepResults);
      if (!conditionMet) continue;
    }

    // Respond with text and optionally stop
    if (step.respond !== undefined) {
      const text = resolveVariables(step.respond, captures, userCtx, stepResults) as string;
      return { success: true, response: text };
    }

    // No call — nothing to execute in this step
    if (step.call === undefined) continue;

    // Suspend for user input
    if (step.call === 'ask_user') {
      return {
        suspended: true,
        suspendedAt: i,
        stepResults: { ...stepResults },
        success: false,
      };
    }

    // Execute tool
    const resolvedInput = resolveVariables(step.input ?? {}, captures, userCtx, stepResults) as Record<string, unknown>;

    const result = await executeTool(step.call, resolvedInput);
    if (!result.success) {
      cmdLogger.warn({ step: step.call, error: result.error }, 'Intent L2 tool step failed');
      return { success: false, response: result.error };
    }

    if (step.as !== undefined) {
      stepResults[step.as] = result.output !== undefined ? parseToolOutput(result.output) : undefined;
    }
  }

  return { success: true, stepResults };
}

export class IntentExecutor {
  /**
   * Run a workflow (Level 1 or Level 2).
   */
  async run(
    workflow: Record<string, unknown>,
    captures: Record<string, string>,
    userCtx: ExecutorUserContext,
    executeTool: ToolExecutorFn,
    resumeState?: ResumeState,
  ): Promise<ExecutorResult> {
    if (Array.isArray(workflow.tools)) {
      return runLevel1(workflow.tools as Level1Tool[], captures, userCtx, executeTool);
    }

    if (Array.isArray(workflow.steps)) {
      return runLevel2(workflow.steps as Level2Step[], captures, userCtx, executeTool, resumeState);
    }

    return { success: false, response: 'Invalid workflow: missing tools or steps' };
  }
}
