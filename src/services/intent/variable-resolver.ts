import { TZDate } from '@date-fns/tz';
import { addDays, endOfMonth, endOfWeek, format, startOfMonth, startOfWeek } from 'date-fns';

interface UserContext {
  timezone: string;
  language: string;
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

/**
 * Resolve a single variable name to its value.
 * Returns undefined if not resolvable (caller decides how to handle).
 */
function resolveVar(
  name: string,
  captures: Record<string, string>,
  userCtx: UserContext,
  stepResults?: Record<string, unknown>,
): unknown {
  const now = new TZDate(new Date(), userCtx.timezone);

  switch (name) {
    case 'today':
      return format(now, 'yyyy-MM-dd');
    case 'tomorrow':
      return format(addDays(now, 1), 'yyyy-MM-dd');
    case 'week_start':
      return format(startOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'week_end':
      return format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
    case 'month_start':
      return format(startOfMonth(now), 'yyyy-MM-dd');
    case 'month_end':
      return format(endOfMonth(now), 'yyyy-MM-dd');
    case 'user.timezone':
      return userCtx.timezone;
    case 'user.language':
      return userCtx.language;
    default:
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
): unknown {
  if (typeof template === 'string') {
    const pattern = /\{\{([^}]+)\}\}/g;
    const matches = [...template.matchAll(pattern)];

    // If the entire string is a single variable, return the raw resolved value
    // (preserves non-string types like numbers)
    if (matches.length === 1 && template === `{{${matches[0][1]}}}`) {
      const resolved = resolveVar(matches[0][1], captures, userCtx, stepResults);
      return resolved !== undefined ? resolved : template;
    }

    // Otherwise do text substitution, converting everything to string
    return template.replace(pattern, (match, varName: string) => {
      const resolved = resolveVar(varName, captures, userCtx, stepResults);
      return resolved !== undefined ? String(resolved) : match;
    });
  }

  if (Array.isArray(template)) {
    return template.map((item) => resolveVariables(item, captures, userCtx, stepResults));
  }

  if (template !== null && typeof template === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template as Record<string, unknown>)) {
      result[key] = resolveVariables(value, captures, userCtx, stepResults);
    }
    return result;
  }

  return template;
}
