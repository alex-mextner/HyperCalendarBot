import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import type { StepResults } from '../../database/repositories/workflow-session.repository.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { ToolResult, ToolResultData } from '../ai/types.ts';
import { evaluate } from './expression-evaluator.ts';
import { applyFilters, parseFilterChain } from './filter-parser.ts';
import { type EventSummary, type UserContext as ExecutorUserContext, resolveVariables } from './variable-resolver.ts';
import { isBoundedJson, readWorkflowVersion, WorkflowInputError } from './workflow-input.ts';
import type { I18nMap, Level1Tool, Level2Step, Workflow } from './workflow-schema.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateResolvedWorkflowInput } from './workflow-validator.ts';

/**
 * Runtime-only extension of StepResults: includes non-serializable function helpers
 * (isPastHour, isPastDay, etc.) that are re-added on resume and never stored in the DB.
 */
type RuntimeStepResults = StepResults & {
  isPastHour?: (h: unknown) => boolean;
  isPastDay?: (d: unknown) => boolean;
  isAmPmAmbiguous?: (h: unknown) => boolean;
  isPastHourPM?: (h: unknown) => boolean;
};

/**
 * Parse "varName|filter" from an `as` field.
 * Returns filtered value and the variable name to store it under.
 */
function applyAsFilter<T>(raw: string, value: T): { name: string; value: T | string } {
  const pipeIdx = raw.indexOf('|');
  const name = pipeIdx === -1 ? raw : raw.slice(0, pipeIdx);
  const filterExpr = pipeIdx === -1 ? '' : raw.slice(pipeIdx + 1);

  let processed: T | string = value;
  if (filterExpr) {
    try {
      processed = applyFilters(value, parseFilterChain(filterExpr));
    } catch {
      cmdLogger.warn({ as: raw }, 'Intent executor: invalid filter in "as" field, storing raw value');
    }
  }

  return { name, value: processed };
}

function storeResult(as: string, rawValue: unknown, stepResults: RuntimeStepResults): void {
  const { name, value } = applyAsFilter(as, rawValue);
  stepResults[name] = value;
}

type ToolExecutorFn = (toolName: string, input: unknown) => ToolResult | Promise<ToolResult>;

/** Build the initial step-results map pre-populated with event and group context from UserContext. */
function buildEventStepResults(userCtx: ExecutorUserContext): RuntimeStepResults {
  const pre: RuntimeStepResults = {};
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
  /**
   * Structured events behind `response`, when the last tool returned any. The
   * formatter renders these instead of `response`, whose text form is written for
   * the AI agent and would otherwise reach the user verbatim.
   */
  responseEvents?: EventSummary[];
  suspended?: boolean;
  suspendedAt?: number;
  /** v2 choices, already resolved and validated; transport decides how to render. */
  responseOptions?: string[];
  errorCode?: string;
  stepResults?: StepResults;
  /** ID of the last event touched in this workflow — for cross-request last_mentioned_event persistence. */
  mentionedEventId?: number;
}

interface ResumeState {
  stepIndex: number;
  stepResults: StepResults;
  userAnswer: string;
}

/**
 * Parse tool output: if valid JSON, return parsed value; otherwise return raw string.
 * Known array element shapes: event lists, free slots, search results, holidays.
 * Known object shapes: settings maps, text output wrappers.
 */
const ToolOutputItemSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const ToolOutputMapSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const ToolOutputSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(ToolOutputItemSchema),
  ToolOutputMapSchema,
]);

const ToolOutputCodec = jsonCodec(ToolOutputSchema);

type ParsedToolOutput = z.infer<typeof ToolOutputSchema>;

function parseToolOutput(output: string): ParsedToolOutput | string {
  const result = ToolOutputCodec.safeParse(output);
  return result.success ? result.data : output;
}

/**
 * Execute a Level 1 workflow: { tools: [...], format: "..." }
 */
function resolveInput(
  name: string,
  template: unknown,
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  stepResults: StepResults,
  i18n: I18nMap | undefined,
  strict: boolean,
): unknown {
  const input = resolveVariables(template, captures, userCtx, stepResults, i18n, { strict });
  if (!strict) return input;
  if (!isBoundedJson(input)) throw new WorkflowInputError('INVALID_INPUT');
  const checked = validateResolvedWorkflowInput(name, input);
  if (!checked.success) throw new WorkflowInputError('INVALID_INPUT');
  return checked.data;
}

async function runLevel1(
  tools: Level1Tool[],
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  executeTool: ToolExecutorFn,
  i18n?: I18nMap,
  strict = false,
): Promise<ExecutorResult> {
  let lastOutput: string | undefined;
  let lastData: ToolResultData | undefined;

  const eventCtx = buildEventStepResults(userCtx);

  for (const tool of tools) {
    const resolvedInput = resolveInput(tool.name, tool.input, captures, userCtx, eventCtx, i18n, strict);
    const result = await executeTool(tool.name, resolvedInput);
    if (!result.success) {
      cmdLogger.warn({ tool: tool.name, error: result.error }, 'Intent L1 tool step failed');
      return { success: false, response: result.error };
    }
    if (result.stopLoop) {
      // The tool handed control to something outside this workflow (e.g. a Telegram user
      // picker) instead of completing the requested action. Report exactly what happened
      // and stop — running the remaining tools would misreport an unfinished action as done.
      return { success: true, response: result.output, responseEvents: extractEventSummaries(result.data) };
    }
    lastOutput = result.output;
    lastData = result.data;
  }

  return { success: true, response: lastOutput, responseEvents: extractEventSummaries(lastData) };
}

/**
 * Execute a Level 2 workflow: { steps: [...] }
 */
/** Type guard: checks if a ToolResultData element has the full EventSummary shape. */
type ToolResultElement =
  | EventSummary
  | { telegram_id: number; name: string }
  | { matches: import('../ai/types.ts').ContactMatch[] }
  | import('../scheduled/types.ts').ScheduledAiCall
  | import('../scheduled/types.ts').Trigger
  | import('../ai/types.ts').TelegramSessionData;

function isEventSummary(obj: ToolResultElement): obj is EventSummary {
  // All ToolResultData element types have 'id', but only EventSummary has 'date' and 'all_day'
  return 'date' in obj && 'all_day' in obj;
}

function extractEventSummary(data: ToolResultData): EventSummary | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return first && isEventSummary(first) ? first : null;
  }
  return isEventSummary(data) ? data : null;
}

/**
 * Every event behind a result: a list of events, or a single event (e.g. get_event's result,
 * which is not array-wrapped). Undefined when the data holds no event at all.
 */
function extractEventSummaries(data: ToolResultData | undefined): EventSummary[] | undefined {
  if (data === undefined) return undefined;
  if (!Array.isArray(data)) return isEventSummary(data) ? [data] : undefined;
  if (data.length === 0) return undefined;
  const events: EventSummary[] = [];
  for (const item of data) {
    if (!isEventSummary(item)) return undefined;
    events.push(item);
  }
  return events;
}

async function runLevel2(
  steps: Level2Step[],
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  executeTool: ToolExecutorFn,
  resumeState?: ResumeState,
  i18n?: I18nMap,
  strict = false,
): Promise<ExecutorResult> {
  const stepResults: RuntimeStepResults = {
    ...buildEventStepResults(userCtx),
    ...(resumeState?.stepResults ?? {}),
  };

  // tool_outputs namespace: accumulates all step outputs saved via "as" field
  if (!stepResults.tool_outputs || typeof stepResults.tool_outputs !== 'object') {
    stepResults.tool_outputs = {};
  }

  // Make captures ($1, $2, ...) accessible in `when` expressions as numbers when possible
  for (const [k, v] of Object.entries(captures)) {
    const num = Number(v);
    stepResults[k] = Number.isNaN(num) ? v : num;
  }

  // When resuming, store the user answer and auto-accumulate to choices[]
  let startIndex = 0;
  if (resumeState !== undefined) {
    if (
      strict &&
      (!Number.isInteger(resumeState.stepIndex) ||
        resumeState.stepIndex < 0 ||
        steps[resumeState.stepIndex]?.call !== 'ask_user')
    )
      throw new WorkflowInputError('INVALID_RESUME');
    const suspendedStep = steps[resumeState.stepIndex];
    if (strict) {
      const prompt = resolveInput(
        'ask_user',
        suspendedStep?.input ?? {},
        captures,
        userCtx,
        stepResults,
        i18n,
        true,
      ) as { question: string; options?: string[] };
      if (prompt.options && !prompt.options.includes(resumeState.userAnswer.trim())) {
        return {
          success: false,
          suspended: true,
          suspendedAt: resumeState.stepIndex,
          stepResults: { ...stepResults },
          response: prompt.question,
          responseOptions: prompt.options,
        };
      }
    }

    // Determine filtered value (apply `as` filter if present, else raw answer).
    // applyAsFilter returns unknown; narrow to string | number since user answers are always text
    // and applyFilters always returns string.
    const rawAnswer = suspendedStep?.as
      ? applyAsFilter(suspendedStep.as, resumeState.userAnswer).value
      : resumeState.userAnswer;
    const filteredAnswer: string | number = typeof rawAnswer === 'number' ? rawAnswer : String(rawAnswer);

    // Auto-accumulate every ask_user answer into choices[]
    if (!Array.isArray(stepResults.choices)) stepResults.choices = [];
    stepResults.choices.push(filteredAnswer);

    // Store under ask.* namespace and tool_outputs.*
    if (suspendedStep?.as) {
      const { name } = applyAsFilter(suspendedStep.as, resumeState.userAnswer);
      if (!stepResults.ask || typeof stepResults.ask !== 'object') stepResults.ask = {};
      stepResults.ask[name] = filteredAnswer;
      if (stepResults.tool_outputs) stepResults.tool_outputs[name] = filteredAnswer;
    }

    startIndex = resumeState.stepIndex + 1;
  }

  let mentionedEventId: number | undefined;
  let lastToolOutput: string | undefined;
  let lastToolData: ToolResultData | undefined;

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    if (!step) {
      cmdLogger.warn({ stepIndex: i }, 'Intent executor: undefined step in dense array, skipping');
      continue;
    }

    // Evaluate `when` condition — skip step if false
    if (step.when !== undefined) {
      const conditionMet = evaluate(step.when, stepResults);
      if (!conditionMet) continue;
    }

    // Respond with text and optionally stop
    if (step.respond !== undefined) {
      const text = resolveVariables(step.respond, captures, userCtx, stepResults, i18n, { strict });
      if (strict && typeof text !== 'string') throw new WorkflowInputError('INVALID_INPUT');
      return { success: true, response: text as string, mentionedEventId };
    }

    // No call — nothing to execute in this step
    if (step.call === undefined) continue;

    // Respond with text from input.message and stop — same as respond: field but explicit call form
    if (step.call === 'respond') {
      if (strict) {
        const value = resolveInput('respond', step.input ?? {}, captures, userCtx, stepResults, i18n, true) as {
          message: string;
        };
        return { success: true, response: value.message, mentionedEventId };
      }
      if (!step.input?.message) {
        cmdLogger.warn({ stepIndex: i }, 'Intent executor: call: respond missing input.message');
        return { success: true, response: undefined, mentionedEventId };
      }
      const text = resolveVariables(step.input.message, captures, userCtx, stepResults, i18n, { strict }) as string;
      return { success: true, response: text, mentionedEventId };
    }

    // Suspend for user input — resolve question text if provided
    if (step.call === 'ask_user') {
      if (strict) {
        const checked = resolveInput('ask_user', step.input ?? {}, captures, userCtx, stepResults, i18n, true) as {
          question: string;
          options?: string[];
        };
        return {
          success: false,
          suspended: true,
          suspendedAt: i,
          stepResults: { ...stepResults },
          response: checked.question,
          responseOptions: checked.options,
        };
      }
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
    const resolvedInput = resolveInput(
      step.call,
      step.input ?? {},
      captures,
      userCtx,
      stepResults,
      i18n,
      strict,
    ) as Record<string, unknown>;

    const result = await executeTool(step.call, resolvedInput);
    if (!result.success) {
      cmdLogger.warn({ step: step.call, error: result.error }, 'Intent L2 tool step failed');
      return { success: false, response: result.error };
    }

    if (result.stopLoop) {
      // The tool handed control to something outside this workflow (e.g. a Telegram user
      // picker) instead of completing the requested action. Report exactly what happened
      // and stop — running a later `respond` step would misreport an unfinished action as done.
      return {
        success: true,
        response: result.output,
        responseEvents: extractEventSummaries(result.data),
        mentionedEventId,
      };
    }

    lastToolOutput = result.output;
    lastToolData = result.data;

    // If result carries structured event data, update last_mentioned_event in-workflow
    // and track the ID for cross-request persistence via mentionedEventId.
    if (result.data !== undefined) {
      const eventSource = extractEventSummary(result.data);
      if (eventSource !== null) {
        stepResults.last_mentioned_event = eventSource;
        mentionedEventId = eventSource.id;
      }
    }

    if (step.as !== undefined) {
      const valueToStore =
        result.data !== undefined
          ? result.data
          : result.output !== undefined
            ? parseToolOutput(result.output)
            : undefined;
      storeResult(step.as, valueToStore, stepResults);
      // Also store in tool_outputs namespace for {{tool_outputs.name.*}} access
      const { name: outputName, value: outputValue } = applyAsFilter(step.as, valueToStore);
      if (stepResults.tool_outputs && outputValue !== undefined) {
        stepResults.tool_outputs[outputName] = outputValue;
      }
    }
  }

  return {
    success: true,
    response: lastToolOutput,
    responseEvents: extractEventSummaries(lastToolData),
    stepResults,
    mentionedEventId,
  };
}

export class IntentExecutor {
  /**
   * Run a workflow (Level 1 or Level 2).
   */
  async run(
    workflow: Workflow,
    captures: Record<string, string>,
    userCtx: ExecutorUserContext,
    executeTool: ToolExecutorFn,
    resumeState?: ResumeState,
  ): Promise<ExecutorResult> {
    const version = readWorkflowVersion(workflow);
    if (version === 'invalid') return { success: false, errorCode: 'INVALID_WORKFLOW' };
    // This public entry also accepts constructed workflows; revalidation is bounded defense-in-depth.
    if (version === 2) {
      const parsed = WorkflowSchema.safeParse(workflow);
      if (!parsed.success) return { success: false, errorCode: 'INVALID_WORKFLOW' };
      workflow = parsed.data;
    }
    if (
      userCtx.workflowInteraction === 'unavailable' &&
      'steps' in workflow &&
      workflow.steps.some((step) => step.call === 'ask_user')
    ) {
      return {
        success: false,
        errorCode: 'INTERACTION_UNAVAILABLE',
        response: 'This workflow needs a reply in the bot chat before it can run.',
      };
    }
    try {
      if ('tools' in workflow)
        return await runLevel1(workflow.tools, captures, userCtx, executeTool, workflow.i18n, version === 2);
      return await runLevel2(workflow.steps, captures, userCtx, executeTool, resumeState, workflow.i18n, version === 2);
    } catch (error) {
      if (!(error instanceof WorkflowInputError)) throw error;
      return { success: false, errorCode: error.code, response: 'The workflow could not safely resolve this step.' };
    }
  }
}
