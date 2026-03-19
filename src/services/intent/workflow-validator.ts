import { type FilterCall, KNOWN_FILTERS, parseFilterChain } from './filter-parser.ts';

/** Variables that the intent workflow executor can resolve. */
const ALLOWED_VARS = new Set([
  // Dates (current user's timezone)
  'dates.today',
  'dates.yesterday',
  'dates.tomorrow',
  'dates.week_start',
  'dates.week_end',
  'dates.next_week_start',
  'dates.next_week_end',
  'dates.month_start',
  'dates.month_end',
  // Current datetime ISO string with timezone offset
  'dates.now',
  // Environment / chat context
  'env.scope',
  // Sender's profile (the user who wrote the message)
  'user.id',
  'user.username',
  'user.first_name',
  'user.timezone',
  'user.language',
  // Group context (false / null in private chats)
  'group.is_group',
  'group.chat_id',
]);

const CAPTURE_VAR_RE = /^\$(\d+)$/;

/** Count capturing (non-non-capturing) groups in a regex pattern string. */
function countCapturingGroups(pattern: string): number {
  // Count `(` that are NOT followed by `?` (i.e., not `(?:`, `(?=`, `(?!`, etc.)
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '(' && pattern[i + 1] !== '?') count++;
  }
  return count;
}

/** Extract all {{expr}} expressions from any string value in a JSON-like object. */
function extractExprs(obj: unknown): string[] {
  const found: string[] = [];
  const VAR_RE = /\{\{([^}]+)\}\}/g;

  function walk(value: unknown): void {
    if (typeof value === 'string') {
      for (const m of value.matchAll(VAR_RE)) {
        found.push(m[1]!);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  }

  walk(obj);
  return found;
}

/**
 * Validate that all {{expr}} references in a workflow are resolvable.
 * Returns a list of human-readable error strings (empty = valid).
 */
export function validateWorkflowVariables(
  workflow: Record<string, unknown>,
  pattern: string | null | undefined,
): string[] {
  const errors: string[] = [];
  const capGroups = pattern ? countCapturingGroups(pattern) : 0;

  for (const expr of extractExprs(workflow)) {
    // Split off filter chain
    const pipeIdx = expr.indexOf('|');
    const varName = pipeIdx === -1 ? expr : expr.slice(0, pipeIdx);
    const filterExpr = pipeIdx === -1 ? '' : expr.slice(pipeIdx + 1);

    // Validate variable name
    if (varName.startsWith('last_added_event.') || varName.startsWith('last_mentioned_event.')) {
      // event context — always valid
    } else {
      const captureMatch = CAPTURE_VAR_RE.exec(varName);
      if (captureMatch) {
        const n = Number.parseInt(captureMatch[1]!, 10);
        if (n < 1 || n > capGroups) {
          errors.push(
            `{{${expr}}}: capture group $${n} does not exist in pattern (pattern has ${capGroups} capturing group${capGroups === 1 ? '' : 's'})`,
          );
        }
      } else if (!ALLOWED_VARS.has(varName)) {
        errors.push(
          `{{${expr}}}: unknown variable — allowed: ${[...ALLOWED_VARS].join(', ')}, or $1..$N from pattern capture groups`,
        );
      }
    }

    // Validate filter chain syntax and known filter names
    if (filterExpr) {
      let filters: FilterCall[];
      try {
        filters = parseFilterChain(filterExpr);
      } catch (e) {
        errors.push(`{{${expr}}}: invalid filter syntax — ${String(e)}`);
        continue;
      }
      for (const f of filters) {
        if (!KNOWN_FILTERS.has(f.name)) {
          errors.push(`{{${expr}}}: unknown filter "${f.name}" — known filters: ${[...KNOWN_FILTERS].join(', ')}`);
        }
      }
    }
  }

  return errors;
}
