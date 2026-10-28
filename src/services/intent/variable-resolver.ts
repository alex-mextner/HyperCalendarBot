import { TZDate } from '@date-fns/tz';
import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  endOfWeek,
  format,
  startOfMonth,
  startOfWeek,
  subDays,
} from 'date-fns';
import type { StepResults } from '../../database/repositories/workflow-session.repository.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { applyFilters, type FilterCall, parseFilterChain } from './filter-parser.ts';
import type { HumanTimeContext } from './human-time.ts';
import { FORBIDDEN_WORKFLOW_KEYS, WORKFLOW_LIMITS, WorkflowInputError } from './workflow-input.ts';
import type { I18nMap } from './workflow-schema.ts';

interface ResolvePolicy {
  strict: boolean;
  translations: Set<string>;
  outputChars: number;
  operations: number;
}

/**
 * Event summary available as template variables in intent workflows.
 *
 * Defined as a type alias (not interface) so that it satisfies TypeScript's
 * index signature assignability — required when storing EventSummary values
 * in { [k: string]: ToolOutputValue } maps.
 */
export type EventSummary = {
  id: number;
  title: string;
  /** YYYY-MM-DD in user's timezone */
  date: string;
  /** HH:MM in user's timezone, absent for all-day events */
  time?: string;
  /** True if event spans entire day (no specific start time) */
  all_day: boolean;
  /** UTC ISO end datetime — use to compute duration */
  end_at?: string;
  /** Event description or notes */
  description?: string;
  /** Venue, address, or room */
  location?: string;
  /** RFC 5545 recurrence rule — present only for recurring events */
  recurrence_rule?: string;
};

export interface UserContext {
  /** Scheduled jobs cannot persist interactive chat questions. */
  workflowInteraction?: 'chat' | 'unavailable';
  timezone: string;
  language: string;
  /** Telegram @username of the message sender (without @). Undefined if the user has no username. */
  username?: string;
  /** First name of the message sender. */
  firstName?: string;
  /** Telegram user ID of the message sender. */
  userId?: number;
  /** Most recently created event by this user. Available as {{last_added_event.id}}, .title, .date, .time */
  lastAddedEvent?: EventSummary;
  /** Most recently referenced event in this conversation. Available as {{last_mentioned_event.id}}, .title, .date, .time */
  lastMentionedEvent?: EventSummary;
  /** True when the message was sent from a group/supergroup chat. */
  groupIsGroup?: boolean;
  /** Telegram chat ID of the group, if applicable. Available as {{group.chat_id}}. */
  groupChatId?: number;
}

/** One path step of `accessPath`: a number indexes an array, a string reads an own, non-forbidden key. */
function stepInto(current: unknown, seg: string | number): unknown {
  if (current === null || current === undefined) return undefined;
  if (typeof seg === 'number') return Array.isArray(current) ? (current as unknown[])[seg] : undefined;
  if (!Object.hasOwn(current, seg) || FORBIDDEN_WORKFLOW_KEYS.has(seg)) return undefined;
  return (current as { [key: string]: unknown })[seg];
}

/**
 * Access a nested path like "results[0].id" or "results.length" in an object.
 * Returns undefined if any segment of the path doesn't exist.
 */
function accessPath(obj: { [key: string]: unknown }, path: string): unknown {
  // Parse path into segments: "results[0].id" → ["results", 0, "id"]
  const segments: (string | number)[] = [];
  const raw = path.replace(/\[(\d+)\]/g, '.$1');
  for (const part of raw.split('.')) {
    if (part === '') continue;
    const n = Number.parseInt(part, 10);
    segments.push(Number.isNaN(n) ? part : n);
  }

  let current: unknown = obj;
  for (const seg of segments) current = stepInto(current, seg);
  return current;
}

/** Built-in variables that need no captures or step results; `now` is the user's local time. */
const BUILTIN_VARS: Record<string, (now: TZDate, userCtx: UserContext) => unknown> = {
  'dates.today': (now) => format(now, 'yyyy-MM-dd'),
  'dates.tomorrow': (now) => format(addDays(now, 1), 'yyyy-MM-dd'),
  'dates.week_start': (now) => format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  'dates.week_end': (now) => format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  'dates.month_start': (now) => format(startOfMonth(now), 'yyyy-MM-dd'),
  'dates.month_end': (now) => format(endOfMonth(now), 'yyyy-MM-dd'),
  'dates.next_month_start': (now) => format(startOfMonth(addMonths(now, 1)), 'yyyy-MM-dd'),
  'dates.yesterday': (now) => format(subDays(now, 1), 'yyyy-MM-dd'),
  'dates.next_week_start': (now) => format(startOfWeek(addWeeks(now, 1), { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  'dates.next_week_end': (now) => format(endOfWeek(addWeeks(now, 1), { weekStartsOn: 1 }), 'yyyy-MM-dd'),
  'dates.now': (now) => format(now, "yyyy-MM-dd'T'HH:mm:ssxxx"),
  'env.scope': (_now, userCtx) => (userCtx.groupIsGroup ? 'group' : 'personal'),
  'user.timezone': (_now, userCtx) => userCtx.timezone,
  'user.language': (_now, userCtx) => userCtx.language,
  'user.username': (_now, userCtx) => userCtx.username,
  'user.first_name': (_now, userCtx) => userCtx.firstName,
  'user.id': (_now, userCtx) => userCtx.userId,
  'user.utc_offset': (now) => format(now, 'xxx'),
  'group.is_group': (_now, userCtx) => userCtx.groupIsGroup ?? false,
  'group.chat_id': (_now, userCtx) => userCtx.groupChatId,
};

/** `t.*` namespace — lazy i18n lookup of `key` in the user's language (falling back to English). */
function resolveTranslation(
  key: string,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults: StepResults | undefined,
  i18n: I18nMap,
  policy: ResolvePolicy | undefined,
): unknown {
  const langDict: { [key: string]: string } = i18n[userCtx.language] ?? i18n.en ?? {};
  const raw = Object.hasOwn(langDict, key) ? langDict[key] : undefined;
  if (raw === undefined) return undefined;
  // Lazy: resolve any {{}} inside the i18n string with current context
  if (policy?.strict) {
    if (policy.translations.has(key) || policy.translations.size >= WORKFLOW_LIMITS.translationDepth)
      throw new WorkflowInputError('UNRESOLVED_TEMPLATE');
    policy.translations.add(key);
    try {
      return resolveInner(raw, captures, userCtx, stepResults, i18n, policy);
    } finally {
      policy.translations.delete(key);
    }
  }
  return resolveVariables(raw, captures, userCtx, stepResults, i18n);
}

/**
 * Resolve a single variable name to its value.
 * Returns undefined if not resolvable (caller decides how to handle).
 */
function resolveVar(
  name: string,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: StepResults,
  i18n?: I18nMap,
  policy?: ResolvePolicy,
  /** The template gives this variable a default(), so its absence is expected, not worth a warning. */
  hasDefault = false,
): unknown {
  consumeResolution(policy);
  const now = new TZDate(new Date(), userCtx.timezone);

  if (Object.hasOwn(BUILTIN_VARS, name)) return BUILTIN_VARS[name]!(now, userCtx);
  if (name.startsWith('t.') && i18n)
    return resolveTranslation(name.slice(2), captures, userCtx, stepResults, i18n, policy);

  // Capture groups: $1, $2, etc.
  if (Object.hasOwn(captures, name)) {
    return captures[name];
  }

  // Step results: dot/bracket path access
  if (stepResults) {
    const value = accessPath(stepResults, name);
    if (value !== undefined) return value;
  }

  if (!hasDefault) cmdLogger.warn({ varName: name }, 'Intent template variable could not be resolved');
  return undefined;
}

/** Output length and cycle depth do not bound empty-string translation fan-out. */
function consumeResolution(policy?: ResolvePolicy): void {
  if (policy?.strict && ++policy.operations > WORKFLOW_LIMITS.resolutionSteps)
    throw new WorkflowInputError('INVALID_INPUT');
}

function accountOutput(value: unknown, policy?: ResolvePolicy): unknown {
  if (policy?.strict && typeof value === 'string') {
    policy.outputChars += value.length;
    if (value.length > WORKFLOW_LIMITS.stringChars || policy.outputChars > WORKFLOW_LIMITS.totalChars)
      throw new WorkflowInputError('INVALID_INPUT');
  }
  return value;
}

/** Single-variable template `{{name}}` (no filter): the variable expression, else null. */
function soleVariableExpr(template: string, matches: RegExpMatchArray[]): string | null {
  const expr = matches.length === 1 ? matches[0]![1] : undefined;
  return expr !== undefined && template === `{{${expr}}}` && !expr.includes('|') ? expr : null;
}

/** Render one `{{name|filter|...}}` expression as text; an unresolvable one stays as written (`match`). */
function renderExpression(
  expr: string,
  match: string,
  resolveName: (name: string, hasDefault: boolean) => unknown,
  strict: boolean | undefined,
  context: HumanTimeContext,
): string {
  const pipeIdx = expr.indexOf('|');
  const varName = (pipeIdx === -1 ? expr : expr.slice(0, pipeIdx)).trim();
  const filterExpr = pipeIdx === -1 ? '' : expr.slice(pipeIdx + 1);

  const resolved = resolveName(varName, /\bdefault\(/.test(filterExpr));

  if (!filterExpr) {
    if (resolved === undefined && strict) throw new WorkflowInputError('UNRESOLVED_TEMPLATE');
    return resolved !== undefined ? String(resolved) : match;
  }

  let filters: FilterCall[];
  try {
    filters = parseFilterChain(filterExpr);
  } catch {
    if (strict) throw new WorkflowInputError('UNRESOLVED_TEMPLATE');
    cmdLogger.warn({ expr }, 'Invalid filter expression in intent template');
    return match;
  }

  // default() can produce a value even when resolved is undefined
  if (resolved === undefined && strict && !filters.some((f) => f.name === 'default' && f.args.length === 1))
    throw new WorkflowInputError('UNRESOLVED_TEMPLATE');
  return applyFilters(resolved, filters, context);
}

function resolveTemplateString(
  template: string,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: StepResults,
  i18n?: I18nMap,
  policy?: ResolvePolicy,
): unknown {
  const pattern = /\{\{([^}]+)\}\}/g;
  const matches = [...template.matchAll(pattern)];
  const resolveName = (name: string, hasDefault = false) =>
    resolveVar(name, captures, userCtx, stepResults, i18n, policy, hasDefault);

  // If the entire string is a single variable (no filter), return the raw resolved value
  // (preserves non-string types like numbers)
  const soleExpr = soleVariableExpr(template, matches);
  if (soleExpr !== null) {
    const resolved = resolveName(soleExpr.trim());
    if (resolved === undefined && policy?.strict) throw new WorkflowInputError('UNRESOLVED_TEMPLATE');
    return accountOutput(resolved !== undefined ? resolved : template, policy);
  }

  // Otherwise do text substitution, converting everything to string
  let outputLength = template.length;
  const output = template.replace(pattern, (match, expr: string) => {
    const value = renderExpression(expr, match, resolveName, policy?.strict, {
      now: new Date(),
      timezone: userCtx.timezone,
      language: userCtx.language,
    });
    outputLength += value.length - match.length;
    if (policy?.strict && outputLength > WORKFLOW_LIMITS.stringChars) throw new WorkflowInputError('INVALID_INPUT');
    return value;
  });
  return accountOutput(output, policy);
}

function resolveInner(
  template: unknown,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: StepResults,
  i18n?: I18nMap,
  policy?: ResolvePolicy,
): unknown {
  consumeResolution(policy);
  if (typeof template === 'string')
    return resolveTemplateString(template, captures, userCtx, stepResults, i18n, policy);

  if (Array.isArray(template)) {
    return template.map((item) => resolveInner(item, captures, userCtx, stepResults, i18n, policy));
  }

  if (template !== null && typeof template === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const [key, value] of Object.entries(template as { [key: string]: unknown })) {
      result[key] = resolveInner(value, captures, userCtx, stepResults, i18n, policy);
    }
    return result;
  }

  return template;
}

/**
 * Resolve {{...}} variables in a value. Works on strings (template substitution)
 * and objects (recursively resolve all string values).
 * v2 strict mode rejects unresolved authored references, not braces supplied as user data.
 */
export function resolveVariables(
  template: unknown,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: StepResults,
  i18n?: I18nMap,
  options?: { strict?: boolean },
): unknown {
  return resolveInner(template, captures, userCtx, stepResults, i18n, {
    strict: options?.strict === true,
    translations: new Set(),
    outputChars: 0,
    operations: 0,
  });
}
