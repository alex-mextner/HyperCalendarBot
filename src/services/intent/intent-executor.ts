import { TZDate } from '@date-fns/tz';
import { cmdLogger } from '../../utils/logger.ts';
import type { ToolResult } from '../ai/types.ts';
import { evaluate } from './expression-evaluator.ts';
import { applyFilters, parseFilterChain } from './filter-parser.ts';
import { type UserContext as ExecutorUserContext, type I18nMap, resolveVariables } from './variable-resolver.ts';

/**
 * Parse "varName|filter" from an `as` field.
 * Returns filtered value and the variable name to store it under.
 */
function applyAsFilter(raw: string, value: unknown): { name: string; value: unknown } {
  const pipeIdx = raw.indexOf('|');
  const name = pipeIdx === -1 ? raw : raw.slice(0, pipeIdx);
  const filterExpr = pipeIdx === -1 ? '' : raw.slice(pipeIdx + 1);

  let processed: unknown = value;
  if (filterExpr) {
    try {
      processed = applyFilters(value, parseFilterChain(filterExpr));
    } catch {
      cmdLogger.warn({ as: raw }, 'Intent executor: invalid filter in "as" field, storing raw value');
    }
  }

  return { name, value: processed };
}

function storeResult(as: string, rawValue: unknown, stepResults: Record<string, unknown>): void {
  const { name, value } = applyAsFilter(as, rawValue);
  stepResults[name] = value;
}

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
  pre.user = {
    id: userCtx.userId,
    language: userCtx.language,
    timezone: userCtx.timezone,
    username: userCtx.username,
    first_name: userCtx.firstName,
  };

  // Timezone-aware helpers for `when` conditions
  const tz = userCtx.timezone;
  pre.isPastHour = (h: unknown) => {
    const n = Number(h);
    return !Number.isNaN(n) && n < new TZDate(new Date(), tz).getHours();
  };
  pre.isPastDay = (d: unknown) => {
    const n = Number(d);
    return !Number.isNaN(n) && n < new TZDate(new Date(), tz).getDate();
  };
  pre.isAmPmAmbiguous = (h: unknown) => {
    const n = Number(h);
    return !Number.isNaN(n) && n >= 1 && n <= 12;
  };
  pre.isPastHourPM = (h: unknown) => {
    const n = Number(h);
    return !Number.isNaN(n) && n + 12 <= new TZDate(new Date(), tz).getHours();
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
  i18n?: I18nMap,
): Promise<ExecutorResult> {
  let lastOutput: string | undefined;

  const eventCtx = buildEventStepResults(userCtx);

  for (const tool of tools) {
    const resolvedInput = resolveVariables(tool.input, captures, userCtx, eventCtx, i18n) as Record<string, unknown>;
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
  i18n?: I18nMap,
): Promise<ExecutorResult> {
  const stepResults: Record<string, unknown> = {
    ...buildEventStepResults(userCtx),
    ...(resumeState?.stepResults ?? {}),
  };

  // Make captures ($1, $2, ...) accessible in `when` expressions as numbers when possible
  for (const [k, v] of Object.entries(captures)) {
    const num = Number(v);
    stepResults[k] = Number.isNaN(num) ? v : num;
  }

  // When resuming, store the user answer and auto-accumulate to choices[]
  let startIndex = 0;
  if (resumeState !== undefined) {
    const suspendedStep = steps[resumeState.stepIndex];

    // Determine filtered value (apply `as` filter if present, else raw answer)
    const filteredAnswer = suspendedStep?.as
      ? applyAsFilter(suspendedStep.as, resumeState.userAnswer).value
      : resumeState.userAnswer;

    // Auto-accumulate every ask_user answer into choices[]
    if (!Array.isArray(stepResults.choices)) stepResults.choices = [];
    (stepResults.choices as unknown[]).push(filteredAnswer);

    // Store under ask.* namespace
    if (suspendedStep?.as) {
      const { name } = applyAsFilter(suspendedStep.as, resumeState.userAnswer);
      if (!stepResults.ask || typeof stepResults.ask !== 'object') stepResults.ask = {};
      (stepResults.ask as Record<string, unknown>)[name] = filteredAnswer;
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
      const text = resolveVariables(step.respond, captures, userCtx, stepResults, i18n) as string;
      return { success: true, response: text };
    }

    // No call — nothing to execute in this step
    if (step.call === undefined) continue;

    // Suspend for user input — resolve question text if provided
    if (step.call === 'ask_user') {
      const questionTemplate = step.input?.question;
      const question =
        questionTemplate !== undefined
          ? (resolveVariables(questionTemplate as string, captures, userCtx, stepResults, i18n) as string)
          : undefined;
      return {
        suspended: true,
        suspendedAt: i,
        stepResults: { ...stepResults },
        success: false,
        response: question,
      };
    }

    // Execute tool
    const resolvedInput = resolveVariables(step.input ?? {}, captures, userCtx, stepResults, i18n) as Record<
      string,
      unknown
    >;

    const result = await executeTool(step.call, resolvedInput);
    if (!result.success) {
      cmdLogger.warn({ step: step.call, error: result.error }, 'Intent L2 tool step failed');
      return { success: false, response: result.error };
    }

    if (step.as !== undefined) {
      storeResult(step.as, result.output !== undefined ? parseToolOutput(result.output) : undefined, stepResults);
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
    const i18n = workflow.i18n as I18nMap | undefined;

    if (Array.isArray(workflow.tools)) {
      return runLevel1(workflow.tools as Level1Tool[], captures, userCtx, executeTool, i18n);
    }

    if (Array.isArray(workflow.steps)) {
      return runLevel2(workflow.steps as Level2Step[], captures, userCtx, executeTool, resumeState, i18n);
    }

    return { success: false, response: 'Invalid workflow: missing tools or steps' };
  }
}
