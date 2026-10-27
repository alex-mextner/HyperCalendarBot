import { TZDate } from '@date-fns/tz';
import { z } from 'zod';
import type { StepResults } from '../../database/repositories/workflow-session.repository.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { extractEventSummaries, isEventSummary } from '../ai/event-summaries.ts';
import { isMutationTool, isReadOnlyCall } from '../ai/tool-executor.ts';
import type { ToolResult, ToolResultData } from '../ai/types.ts';
import { evaluate } from './expression-evaluator.ts';
import { applyFilters, parseFilterChain } from './filter-parser.ts';
import { type DayAnswer, formatDayAnswers } from './response-formatter.ts';
import { type EventSummary, type UserContext as ExecutorUserContext, resolveVariables } from './variable-resolver.ts';
import { type BindValues, evaluateBindingReadings } from './workflow-bindings.ts';
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
  count?: (list: unknown) => number;
  has?: (value: unknown) => boolean;
  fits?: (value: unknown, start: unknown, end: unknown) => boolean;
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

const MAX_TEXT_COMPANION_CHARS = 1500;

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
  // Safe on a step that did not run: an absent list counts as empty, an absent value as missing.
  // True only when one verified free interval covers the complete requested window.
  pre.fits = (value: unknown, start: unknown, end: unknown) => {
    const from = typeof start === 'string' ? Date.parse(start) : NaN;
    const to = typeof end === 'string' ? Date.parse(end) : NaN;
    const slots = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Reflect.get(value, 'slots')
        : null;
    if (!Array.isArray(slots) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;
    return slots.some(
      (slot) =>
        slot &&
        typeof slot === 'object' &&
        typeof slot.start === 'string' &&
        typeof slot.end === 'string' &&
        Date.parse(slot.start) <= from &&
        Date.parse(slot.end) >= to,
    );
  };
  pre.count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
  pre.has = (value: unknown) => value !== undefined && value !== null && value !== '';
  pre.isPastHourPM = (h: unknown) => {
    const n = Number(h);
    return !Number.isNaN(n) && n + 12 <= new TZDate(new Date(), tz).getHours();
  };

  return pre;
}

interface ExecutorResult {
  success: boolean;
  /** Only a direct final tool answer can carry this; never a handoff or custom response. */
  completeResponse?: boolean;
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
  /**
   * Whether any step may have changed data. Set on every outcome, failures included, so a
   * caller can tell a retryable failure ('none') from one whose request must never be replayed.
   */
  mutationEvidence?: MutationEvidence;
}

export type MutationEvidence = 'none' | 'applied' | 'unknown';

/** Accumulates direct execution evidence from tool results; never inferred from prose. */
class EvidenceTracker {
  state: MutationEvidence = 'none';

  constructor(previous?: unknown) {
    if (previous === 'applied' || previous === 'unknown') this.state = previous;
  }

  record(tool: string, input: unknown, result: ToolResult): void {
    const mutation =
      result.mutationState ??
      (isMutationTool(tool, input) ? (result.success ? 'confirmed' : 'uncertain') : 'not_applied');
    if (mutation === 'uncertain') this.state = 'unknown';
    else if (mutation === 'confirmed' && this.state === 'none') this.state = 'applied';
  }

  recordThrown(tool: string, input: unknown): void {
    if (isMutationTool(tool, input)) this.state = 'unknown';
  }
}

async function callTool(
  executeTool: ToolExecutorFn,
  tool: string,
  input: unknown,
  evidence: EvidenceTracker,
): Promise<ToolResult> {
  try {
    const result = await executeTool(tool, input);
    evidence.record(tool, input, result);
    return result;
  } catch (error) {
    evidence.recordThrown(tool, input);
    throw error;
  }
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
  evidence: EvidenceTracker,
  bind: BindValues | undefined,
  i18n?: I18nMap,
  strict = false,
): Promise<ExecutorResult> {
  let lastOutput: string | undefined;
  let lastData: ToolResultData | undefined;
  let completeResponse = false;

  const eventCtx = buildEventStepResults(userCtx);
  if (bind) eventCtx.bind = bind;

  for (const tool of tools) {
    const resolvedInput = resolveInput(tool.name, tool.input, captures, userCtx, eventCtx, i18n, strict);
    const result = await callTool(executeTool, tool.name, resolvedInput, evidence);
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
    completeResponse = result.completeResponse === true;
  }

  return {
    success: true,
    response: lastOutput,
    responseEvents: extractEventSummaries(lastData),
    ...(completeResponse && evidence.state === 'none' ? { completeResponse: true } : {}),
  };
}

function extractEventSummary(data: ToolResultData): EventSummary | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return first && isEventSummary(first) ? first : null;
  }
  return isEventSummary(data) ? data : null;
}

/**
 * The event a step makes "last mentioned". Typed workflows never promote one row of a
 * list (a search result is not a selection) or an event the step just deleted.
 */
function extractMentionedEvent(result: ToolResult, strict: boolean): EventSummary | null {
  if (result.data === undefined) return null;
  if (strict && (Array.isArray(result.data) || result.effect?.kind === 'event_deleted')) return null;
  return extractEventSummary(result.data);
}

/** Everything a Level 2 step handler reads; `stepResults` is the one mutable accumulator. */
interface Level2Env {
  captures: Record<string, string>;
  userCtx: ExecutorUserContext;
  executeTool: ToolExecutorFn;
  evidence: EvidenceTracker;
  i18n: I18nMap | undefined;
  strict: boolean;
  stepResults: RuntimeStepResults;
}

/** Values the step loop carries from one executed tool step to the next and into the final result. */
interface Level2LoopState {
  mentionedEventId: number | undefined;
  lastToolOutput: string | undefined;
  lastToolData: ToolResultData | undefined;
  completeResponse: boolean;
}

function resolveStepInput(env: Level2Env, name: string, template: unknown, strict = env.strict): unknown {
  return resolveInput(name, template, env.captures, env.userCtx, env.stepResults, env.i18n, strict);
}

/** Initial Level 2 step results: event context, resumed state, bind values, tool_outputs namespace, captures. */
function seedLevel2StepResults(
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  bind: BindValues | undefined,
  resumeState: ResumeState | undefined,
): RuntimeStepResults {
  const stepResults: RuntimeStepResults = {
    ...buildEventStepResults(userCtx),
    ...(resumeState?.stepResults ?? {}),
  };
  if (bind) stepResults.bind = bind;

  // tool_outputs namespace: accumulates all step outputs saved via "as" field
  if (!stepResults.tool_outputs || typeof stepResults.tool_outputs !== 'object') {
    stepResults.tool_outputs = {};
  }

  // Make captures ($1, $2, ...) accessible in `when` expressions as numbers when possible
  for (const [k, v] of Object.entries(captures)) {
    const num = Number(v);
    stepResults[k] = Number.isNaN(num) ? v : num;
  }
  return stepResults;
}

type StrictAnswer = { answer: string } | { reprompt: ExecutorResult };

/** Typed workflows only accept one of the prompt's options; anything else re-asks the same question. */
function checkStrictAnswer(
  env: Level2Env,
  suspendedStep: Level2Step | undefined,
  resumeState: ResumeState,
): StrictAnswer {
  const answer = resumeState.userAnswer;
  const prompt = resolveStepInput(env, 'ask_user', suspendedStep?.input ?? {}, true) as {
    question: string;
    options?: string[];
  };
  const chosen = prompt.options?.find((option) => option.toLowerCase() === answer.trim().toLowerCase());
  if (chosen !== undefined) return { answer: chosen };
  if (prompt.options) {
    return {
      reprompt: {
        success: false,
        suspended: true,
        suspendedAt: resumeState.stepIndex,
        stepResults: { ...env.stepResults },
        response: prompt.question,
        responseOptions: prompt.options,
      },
    };
  }
  return { answer };
}

function recordResumeAnswer(stepResults: RuntimeStepResults, suspendedStep: Level2Step | undefined, answer: string) {
  // Determine filtered value (apply `as` filter if present, else raw answer).
  // applyAsFilter returns unknown; narrow to string | number since user answers are always text
  // and applyFilters always returns string.
  const rawAnswer = suspendedStep?.as ? applyAsFilter(suspendedStep.as, answer).value : answer;
  const filteredAnswer: string | number = typeof rawAnswer === 'number' ? rawAnswer : String(rawAnswer);

  // Auto-accumulate every ask_user answer into choices[]
  if (!Array.isArray(stepResults.choices)) stepResults.choices = [];
  stepResults.choices.push(filteredAnswer);

  // Store under ask.* namespace and tool_outputs.*
  if (suspendedStep?.as) {
    const { name } = applyAsFilter(suspendedStep.as, answer);
    if (!stepResults.ask || typeof stepResults.ask !== 'object') stepResults.ask = {};
    stepResults.ask[name] = filteredAnswer;
    if (stepResults.tool_outputs) stepResults.tool_outputs[name] = filteredAnswer;
  }
}

/**
 * Store the answer to the suspended `ask_user` step. Returns a result only when a typed
 * workflow must re-ask because the answer is not one of the offered options.
 */
function applyResumeAnswer(steps: Level2Step[], resumeState: ResumeState, env: Level2Env): ExecutorResult | null {
  if (
    env.strict &&
    (!Number.isInteger(resumeState.stepIndex) ||
      resumeState.stepIndex < 0 ||
      steps[resumeState.stepIndex]?.call !== 'ask_user')
  )
    throw new WorkflowInputError('INVALID_RESUME');
  const suspendedStep = steps[resumeState.stepIndex];
  let answer = resumeState.userAnswer;
  if (env.strict) {
    const checked = checkStrictAnswer(env, suspendedStep, resumeState);
    if ('reprompt' in checked) return checked.reprompt;
    answer = checked.answer;
  }
  recordResumeAnswer(env.stepResults, suspendedStep, answer);
  return null;
}

/** `respond:` field — answer with text and stop. */
function respondWithText(template: string, env: Level2Env, mentionedEventId: number | undefined): ExecutorResult {
  const text = resolveVariables(template, env.captures, env.userCtx, env.stepResults, env.i18n, {
    strict: env.strict,
  });
  if (env.strict && typeof text !== 'string') throw new WorkflowInputError('INVALID_INPUT');
  return { success: true, response: text as string, mentionedEventId };
}

/** Respond with text from input.message and stop — same as respond: field but explicit call form. */
function respondWithMessageInput(
  step: Level2Step,
  stepIndex: number,
  env: Level2Env,
  mentionedEventId: number | undefined,
): ExecutorResult {
  if (env.strict) {
    const value = resolveStepInput(env, 'respond', step.input ?? {}, true) as { message: string };
    return { success: true, response: value.message, mentionedEventId };
  }
  if (!step.input?.message) {
    cmdLogger.warn({ stepIndex }, 'Intent executor: call: respond missing input.message');
    return { success: true, response: undefined, mentionedEventId };
  }
  const text = resolveVariables(step.input.message, env.captures, env.userCtx, env.stepResults, env.i18n, {
    strict: env.strict,
  }) as string;
  return { success: true, response: text, mentionedEventId };
}

/** Suspend for user input — resolve question text if provided. */
function suspendForAnswer(step: Level2Step, stepIndex: number, env: Level2Env): ExecutorResult {
  if (env.evidence.state !== 'none') env.stepResults.__mutationEvidence = env.evidence.state;
  if (env.strict) {
    const checked = resolveStepInput(env, 'ask_user', step.input ?? {}, true) as {
      question: string;
      options?: string[];
    };
    return {
      success: false,
      suspended: true,
      suspendedAt: stepIndex,
      stepResults: { ...env.stepResults },
      response: checked.question,
      responseOptions: checked.options,
    };
  }
  const questionTemplate = step.input?.question;
  const question =
    questionTemplate !== undefined
      ? (resolveVariables(questionTemplate as string, env.captures, env.userCtx, env.stepResults, env.i18n) as string)
      : undefined;
  return {
    suspended: true,
    suspendedAt: stepIndex,
    stepResults: { ...env.stepResults },
    success: false,
    response: question,
  };
}

/** Store a tool result under the step's `as` name, in `tool_outputs`, and (typed workflows) its text companion. */
function storeStepOutput(as: string, result: ToolResult, env: Level2Env): void {
  const { stepResults } = env;
  const valueToStore =
    result.data !== undefined ? result.data : result.output !== undefined ? parseToolOutput(result.output) : undefined;
  storeResult(as, valueToStore, stepResults);
  // Also store in tool_outputs namespace for {{tool_outputs.name.*}} access
  const { name: outputName, value: outputValue } = applyAsFilter(as, valueToStore);
  if (stepResults.tool_outputs && outputValue !== undefined) {
    stepResults.tool_outputs[outputName] = outputValue;
  }
  // Typed workflows can show the tool's own text next to the structured value.
  if (env.strict && stepResults.tool_outputs && result.output !== undefined) {
    stepResults.tool_outputs[`${outputName}_text`] = result.output.slice(0, MAX_TEXT_COMPANION_CHARS);
  }
}

/**
 * Execute one tool step. Returns a final result when the workflow must stop (tool failure or
 * hand-off); otherwise records the output in `state`/`stepResults` and returns null.
 */
async function runToolStep(
  step: Level2Step,
  call: string,
  env: Level2Env,
  state: Level2LoopState,
): Promise<ExecutorResult | null> {
  const resolvedInput = resolveStepInput(env, call, step.input ?? {});

  const result = await callTool(env.executeTool, call, resolvedInput, env.evidence);
  if (!result.success) {
    cmdLogger.warn({ step: call, error: result.error }, 'Intent L2 tool step failed');
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
      mentionedEventId: state.mentionedEventId,
    };
  }

  state.lastToolOutput = result.output;
  state.lastToolData = result.data;
  state.completeResponse = result.completeResponse === true;

  // If result carries structured event data, update last_mentioned_event in-workflow
  // and track the ID for cross-request persistence via mentionedEventId.
  const eventSource = extractMentionedEvent(result, env.strict);
  if (eventSource !== null) {
    env.stepResults.last_mentioned_event = eventSource;
    state.mentionedEventId = eventSource.id;
  }

  if (step.as !== undefined) storeStepOutput(step.as, result, env);
  return null;
}

/**
 * Run one step of the loop. Returns a final result when this step ends the workflow
 * (respond / suspend / failure / hand-off), or null to continue with the next step.
 */
async function runLevel2Step(
  step: Level2Step,
  stepIndex: number,
  env: Level2Env,
  state: Level2LoopState,
): Promise<ExecutorResult | null> {
  // Evaluate `when` condition — skip step if false
  if (step.when !== undefined && !evaluate(step.when, env.stepResults)) return null;

  // Respond with text and optionally stop
  if (step.respond !== undefined) return respondWithText(step.respond, env, state.mentionedEventId);

  // No call — nothing to execute in this step
  if (step.call === undefined) return null;

  if (step.call === 'respond') return respondWithMessageInput(step, stepIndex, env, state.mentionedEventId);
  if (step.call === 'ask_user') return suspendForAnswer(step, stepIndex, env);
  return runToolStep(step, step.call, env, state);
}

/**
 * Execute a Level 2 workflow: { steps: [...] }
 */
async function runLevel2(
  steps: Level2Step[],
  captures: Record<string, string>,
  userCtx: ExecutorUserContext,
  executeTool: ToolExecutorFn,
  evidence: EvidenceTracker,
  bind: BindValues | undefined,
  resumeState?: ResumeState,
  i18n?: I18nMap,
  strict = false,
): Promise<ExecutorResult> {
  const stepResults = seedLevel2StepResults(captures, userCtx, bind, resumeState);
  const env: Level2Env = { captures, userCtx, executeTool, evidence, i18n, strict, stepResults };

  // When resuming, store the user answer and auto-accumulate to choices[]
  let startIndex = 0;
  if (resumeState !== undefined) {
    const reprompt = applyResumeAnswer(steps, resumeState, env);
    if (reprompt !== null) return reprompt;
    startIndex = resumeState.stepIndex + 1;
  }

  const state: Level2LoopState = {
    mentionedEventId: undefined,
    lastToolOutput: undefined,
    lastToolData: undefined,
    completeResponse: false,
  };

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    if (!step) {
      cmdLogger.warn({ stepIndex: i }, 'Intent executor: undefined step in dense array, skipping');
      continue;
    }
    const finished = await runLevel2Step(step, i, env, state);
    if (finished !== null) return finished;
  }

  return {
    success: true,
    response: state.lastToolOutput,
    ...(state.completeResponse && evidence.state === 'none' ? { completeResponse: true } : {}),
    responseEvents: extractEventSummaries(state.lastToolData),
    stepResults,
    mentionedEventId: state.mentionedEventId,
  };
}

/**
 * Running a workflow once per day is safe only when every step only reads. A written
 * response is not a read: repeated, it would say the same text under both days.
 * Classification uses the unresolved step input, so it can only err towards running once.
 */
function isReadOnly(workflow: Workflow): boolean {
  if ('tools' in workflow) return workflow.tools.every((tool) => isReadOnlyCall(tool.name, tool.input));
  return workflow.steps.every((step) => step.call !== undefined && isReadOnlyCall(step.call, step.input));
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
    if (version === 'invalid') return { success: false, errorCode: 'INVALID_WORKFLOW', mutationEvidence: 'none' };
    // This public entry also accepts constructed workflows; revalidation is bounded defense-in-depth.
    if (version === 2) {
      const parsed = WorkflowSchema.safeParse(workflow);
      if (!parsed.success) return { success: false, errorCode: 'INVALID_WORKFLOW', mutationEvidence: 'none' };
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
        mutationEvidence: 'none',
      };
    }
    const evidence = new EvidenceTracker(resumeState?.stepResults.__mutationEvidence);
    try {
      const result = await this.execute(workflow, captures, userCtx, executeTool, evidence, version === 2, resumeState);
      return { ...result, mutationEvidence: evidence.state };
    } catch (error) {
      if (error instanceof WorkflowInputError) {
        return {
          success: false,
          errorCode: error.code,
          response: 'The workflow could not safely resolve this step.',
          mutationEvidence: evidence.state,
        };
      }
      // A write whose outcome is unknown must reach the caller as evidence, not as an exception it may retry.
      if (evidence.state === 'none') throw error;
      cmdLogger.error({ err: error }, 'Intent workflow tool threw after a possible write');
      return { success: false, errorCode: 'TOOL_ERROR', mutationEvidence: evidence.state };
    }
  }

  private async execute(
    workflow: Workflow,
    captures: Record<string, string>,
    userCtx: ExecutorUserContext,
    executeTool: ToolExecutorFn,
    evidence: EvidenceTracker,
    strict: boolean,
    resumeState?: ResumeState,
  ): Promise<ExecutorResult> {
    const run = (bind: BindValues | undefined): Promise<ExecutorResult> =>
      'tools' in workflow
        ? runLevel1(workflow.tools, captures, userCtx, executeTool, evidence, bind, workflow.i18n, strict)
        : runLevel2(workflow.steps, captures, userCtx, executeTool, evidence, bind, resumeState, workflow.i18n, strict);
    // A resumed run keeps the values bound when the request was made: a relative date
    // must not shift if the answer arrives after midnight.
    if (resumeState !== undefined || !('bindings' in workflow) || workflow.bindings === undefined)
      return run(undefined);
    const now = new Date();
    const { literal, afterMidnight } = evaluateBindingReadings(
      workflow.bindings,
      captures,
      userCtx,
      workflow.i18n,
      now,
    );
    if (afterMidnight === null || !isReadOnly(workflow)) return run(literal);
    // Just after midnight 'today' and 'tomorrow' may mean either of two days: answer for each, labelled.
    const answers: DayAnswer[] = [];
    for (const { day, bind } of afterMidnight) {
      const result = await run(bind);
      if (!result.success || result.suspended) return result;
      answers.push({ day, response: result.response, events: result.responseEvents });
    }
    return { success: true, response: formatDayAnswers(answers, userCtx.timezone, userCtx.language, now) };
  }
}
