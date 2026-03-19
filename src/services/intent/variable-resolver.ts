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
import { cmdLogger } from '../../utils/logger.ts';
import { applyFilters, type FilterCall, parseFilterChain } from './filter-parser.ts';

/** Event summary available as template variables in intent workflows. */
export interface EventSummary {
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
}

export interface UserContext {
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

/**
 * Access a nested path like "results[0].id" or "results.length" in an object.
 * Returns undefined if any segment of the path doesn't exist.
 */
function accessPath(obj: Record<string, unknown>, path: string): unknown {
  // Parse path into segments: "results[0].id" → ["results", 0, "id"]
  const segments: (string | number)[] = [];
  const raw = path.replace(/\[(\d+)\]/g, '.$1');
  for (const part of raw.split('.')) {
    if (part === '') continue;
    const n = Number.parseInt(part, 10);
    segments.push(Number.isNaN(n) ? part : n);
  }

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[seg];
    } else {
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

/** i18n dictionary: language code → key → template string */
export type I18nMap = Record<string, Record<string, unknown>>;

/**
 * Resolve a single variable name to its value.
 * Returns undefined if not resolvable (caller decides how to handle).
 */
function resolveVar(
  name: string,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: Record<string, unknown>,
  i18n?: I18nMap,
): unknown {
  const now = new TZDate(new Date(), userCtx.timezone);

  switch (name) {
    case 'dates.today':
      return format(now, 'yyyy-MM-dd');
    case 'dates.tomorrow':
      return format(addDays(now, 1), 'yyyy-MM-dd');
    case 'dates.week_start':
      return format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'dates.week_end':
      return format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'dates.month_start':
      return format(startOfMonth(now), 'yyyy-MM-dd');
    case 'dates.month_end':
      return format(endOfMonth(now), 'yyyy-MM-dd');
    case 'dates.next_month_start':
      return format(startOfMonth(addMonths(now, 1)), 'yyyy-MM-dd');
    case 'dates.yesterday':
      return format(subDays(now, 1), 'yyyy-MM-dd');
    case 'dates.next_week_start':
      return format(startOfWeek(addWeeks(now, 1), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'dates.next_week_end':
      return format(endOfWeek(addWeeks(now, 1), { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'dates.now':
      return format(now, "yyyy-MM-dd'T'HH:mm:ssxxx");
    case 'env.scope':
      return userCtx.groupIsGroup ? 'group' : 'personal';
    case 'user.timezone':
      return userCtx.timezone;
    case 'user.language':
      return userCtx.language;
    case 'user.username':
      return userCtx.username;
    case 'user.first_name':
      return userCtx.firstName;
    case 'user.id':
      return userCtx.userId;
    case 'user.utc_offset':
      return format(now, 'xxx');
    case 'group.is_group':
      return userCtx.groupIsGroup ?? false;
    case 'group.chat_id':
      return userCtx.groupChatId;
    default:
      // t.* namespace — lazy i18n lookup
      if (name.startsWith('t.') && i18n) {
        const key = name.slice(2);
        const langDict = i18n[userCtx.language] ?? i18n.en ?? {};
        const raw = langDict[key];
        if (raw === undefined) return undefined;
        // Lazy: resolve any {{}} inside the i18n string with current context
        return resolveVariables(raw, captures, userCtx, stepResults, i18n);
      }
      break;
  }

  // Capture groups: $1, $2, etc.
  if (name in captures) {
    return captures[name];
  }

  // Step results: dot/bracket path access
  if (stepResults) {
    const value = accessPath(stepResults, name);
    if (value !== undefined) return value;
  }

  cmdLogger.warn({ varName: name }, 'Intent template variable could not be resolved');
  return undefined;
}

/**
 * Resolve {{...}} variables in a value. Works on strings (template substitution)
 * and objects (recursively resolve all string values).
 */
export function resolveVariables(
  template: unknown,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: Record<string, unknown>,
  i18n?: I18nMap,
): unknown {
  if (typeof template === 'string') {
    const pattern = /\{\{([^}]+)\}\}/g;
    const matches = [...template.matchAll(pattern)];

    // If the entire string is a single variable (no filter), return the raw resolved value
    // (preserves non-string types like numbers)
    if (matches.length === 1 && template === `{{${matches[0][1]}}}` && !matches[0][1].includes('|')) {
      const resolved = resolveVar(matches[0][1]!.trim(), captures, userCtx, stepResults, i18n);
      return resolved !== undefined ? resolved : template;
    }

    // Otherwise do text substitution, converting everything to string
    return template.replace(pattern, (match, expr: string) => {
      const pipeIdx = expr.indexOf('|');
      const varName = (pipeIdx === -1 ? expr : expr.slice(0, pipeIdx)).trim();
      const filterExpr = pipeIdx === -1 ? '' : expr.slice(pipeIdx + 1);

      const resolved = resolveVar(varName, captures, userCtx, stepResults, i18n);

      if (!filterExpr) {
        return resolved !== undefined ? String(resolved) : match;
      }

      let filters: FilterCall[];
      try {
        filters = parseFilterChain(filterExpr);
      } catch {
        cmdLogger.warn({ expr }, 'Invalid filter expression in intent template');
        return match;
      }

      // default() can produce a value even when resolved is undefined
      const result = applyFilters(resolved, filters);
      return result;
    });
  }

  if (Array.isArray(template)) {
    return template.map((item) => resolveVariables(item, captures, userCtx, stepResults, i18n));
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      result[key] = resolveVariables(value, captures, userCtx, stepResults, i18n);
    }
    return result;
  }

  return template;
}
