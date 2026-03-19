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
  'dates.next_month_start',
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
  'user.utc_offset',
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

/** Collect all "as" field values from Level 2 steps in the workflow. */
function extractAsFields(workflow: Record<string, unknown>): string[] {
  const found: string[] = [];
  const steps = workflow.steps;
  if (!Array.isArray(steps)) return found;
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      const as = (step as Record<string, unknown>).as;
      if (typeof as === 'string') found.push(as);
    }
  }
  return found;
}

/** Collect variable names stored by ask_user steps (the name before any | filter). */
function extractAskUserNames(workflow: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  const steps = workflow.steps;
  if (!Array.isArray(steps)) return names;
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      const s = step as Record<string, unknown>;
      if (s.call === 'ask_user' && typeof s.as === 'string') {
        const name = s.as.includes('|') ? s.as.slice(0, s.as.indexOf('|')) : s.as;
        names.add(name.trim());
      }
    }
  }
  return names;
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
  const askUserNames = extractAskUserNames(workflow);

  // Validate filter chains in "as" fields (e.g. "choice|lower")
  for (const asValue of extractAsFields(workflow)) {
    const pipeIdx = asValue.indexOf('|');
    if (pipeIdx === -1) continue;
    const filterExpr = asValue.slice(pipeIdx + 1);
    let filters: FilterCall[];
    try {
      filters = parseFilterChain(filterExpr);
    } catch (e) {
      errors.push(`as "${asValue}": invalid filter syntax — ${String(e)}`);
      continue;
    }
    for (const f of filters) {
      if (!KNOWN_FILTERS.has(f.name)) {
        errors.push(`as "${asValue}": unknown filter "${f.name}" — known filters: ${[...KNOWN_FILTERS].join(', ')}`);
      }
    }
  }

  for (const expr of extractExprs(workflow)) {
    // Split off filter chain
    const pipeIdx = expr.indexOf('|');
    const varName = pipeIdx === -1 ? expr : expr.slice(0, pipeIdx);
    const filterExpr = pipeIdx === -1 ? '' : expr.slice(pipeIdx + 1);

    // Validate variable name
    if (
      varName.startsWith('last_added_event.') ||
      varName.startsWith('last_mentioned_event.') ||
      varName.startsWith('t.')
    ) {
      // event context and i18n keys — always valid
    } else if (varName.startsWith('ask.')) {
      const askKey = varName.slice('ask.'.length);
      if (!askUserNames.has(askKey)) {
        errors.push(`{{${expr}}}: ask.${askKey} is not defined — no ask_user step with as: "${askKey}" found`);
      }
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
