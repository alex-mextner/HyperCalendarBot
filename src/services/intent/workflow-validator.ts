import { z } from 'zod';
import { toolSchemas } from '../ai/tool-schemas.ts';
import { type FilterCall, KNOWN_FILTERS, parseFilterChain } from './filter-parser.ts';
import type { Workflow } from './workflow-schema.ts';

/** Tool schemas keyed by plain string, so an unknown step name is a lookup miss, not a type error. */
const TOOL_SCHEMAS_BY_NAME: Record<string, z.ZodType> = { ...toolSchemas };

/**
 * Step types the executor handles itself — they never reach the tool dispatcher, so they use
 * their own minimal schemas instead of any AI-facing `toolSchemas` entry of the same name.
 */
const WORKFLOW_ONLY_SCHEMAS: Record<string, z.ZodType> = {
  ask_user: z.object({ question: z.string().min(1) }).passthrough(),
  respond: z.object({ message: z.string().min(1) }).passthrough(),
};

/** Every step type a workflow may call, tool or workflow-only, keyed by name. */
const STEP_SCHEMAS_BY_NAME: Record<string, z.ZodType> = { ...TOOL_SCHEMAS_BY_NAME, ...WORKFLOW_ONLY_SCHEMAS };

/**
 * Tools where at least one field in each listed group must be present. The underlying
 * handler requires one of them and fails deterministically at runtime otherwise, so a
 * workflow missing every field in a group must never be stored.
 */
const REQUIRED_ANY_OF: Record<string, string[][]> = {
  send_invitation: [['invitee_id', 'invitee_username']],
};

/** Look up a key in a static record, ignoring inherited properties like "toString" or "constructor". */
function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

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

/** Detect if an expression looks like a conditional/ternary rather than a plain variable. */
function isConditionalExpr(expr: string): boolean {
  return /==|!=|\?|&&|\|\|/.test(expr);
}

/** Extract all {{expr}} expressions from any string value in a JSON-like object, with paths. */
function extractExprs(obj: unknown): Array<{ expr: string; path: string }> {
  const found: Array<{ expr: string; path: string }> = [];
  const VAR_RE = /\{\{([^}]+)\}\}/g;

  function walk(value: unknown, path: string): void {
    if (typeof value === 'string') {
      for (const m of value.matchAll(VAR_RE)) {
        found.push({ expr: m[1]!, path });
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as { [key: string]: unknown })) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  }

  walk(obj, '');
  return found;
}

/** Collect all "as" field values from Level 2 steps in the workflow. */
function extractAsFields(workflow: Workflow): string[] {
  const found: string[] = [];
  const steps = 'steps' in workflow ? workflow.steps : undefined;
  if (!Array.isArray(steps)) return found;
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      const as = (step as { [key: string]: unknown }).as;
      if (typeof as === 'string') found.push(as);
    }
  }
  return found;
}

/** Collect variable names stored by ask_user steps (the name before any | filter). */
function extractAskUserNames(workflow: Workflow): Set<string> {
  const names = new Set<string>();
  const steps = 'steps' in workflow ? workflow.steps : undefined;
  if (!Array.isArray(steps)) return names;
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      const s = step as { [key: string]: unknown };
      if (s.call === 'ask_user' && typeof s.as === 'string') {
        const name = s.as.includes('|') ? s.as.slice(0, s.as.indexOf('|')) : s.as;
        names.add(name.trim());
      }
    }
  }
  return names;
}

/**
 * Collect variable names stored by non-ask_user steps via their "as" field.
 * These become top-level variables accessible as {{name}} or {{name.field}}.
 */
function extractStepOutputNames(workflow: Workflow): Set<string> {
  const names = new Set<string>();
  const steps = 'steps' in workflow ? workflow.steps : undefined;
  if (!Array.isArray(steps)) return names;
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      const s = step as { [key: string]: unknown };
      if (s.call !== 'ask_user' && typeof s.as === 'string') {
        const name = s.as.includes('|') ? s.as.slice(0, s.as.indexOf('|')) : s.as;
        names.add(name.trim());
      }
    }
  }
  return names;
}

interface StepCall {
  tool: string;
  /** Raw argument values the workflow passes to the tool — always strings until resolved at runtime. */
  input: Record<string, string>;
}

/** Collect every tool invocation in a workflow, from Level 1 `tools` or Level 2 `steps`. */
function extractStepCalls(workflow: Workflow): StepCall[] {
  if ('steps' in workflow) {
    const calls: StepCall[] = [];
    for (const step of workflow.steps) {
      if (typeof step.call !== 'string') continue;
      calls.push({ tool: step.call, input: step.input ?? {} });
    }
    return calls;
  }
  return workflow.tools.map((tool) => ({ tool: tool.name, input: tool.input }));
}

/** Whether a raw input value still holds an unresolved {{...}} template expression. */
function isTemplateValue(value: string): boolean {
  return value.includes('{{');
}

/**
 * Check one step's arguments against the tool's schema: every required field is present,
 * every supplied field is known, and every literal (non-template) value matches the field's
 * type. Template values (e.g. "{{$1}}") are exempt from the type check — resolveVariables
 * only preserves the concrete resolved type for a bare single-variable template; every other
 * shape (mixed text, filters) becomes a string at execution time.
 */
function validateStepParams(call: StepCall, schema: z.ZodType): string[] {
  // Free-form schemas (assistant passthrough tools) accept any argument.
  if (!(schema instanceof z.ZodObject)) return [];

  const errors: string[] = [];
  const shape = schema.shape;
  const paramNames = Object.keys(call.input);

  for (const [field, fieldSchema] of Object.entries(shape)) {
    const isOptional = fieldSchema.safeParse(undefined).success;
    if (!isOptional && !paramNames.includes(field)) {
      errors.push(`step "${call.tool}": required parameter "${field}" is missing`);
    }
  }

  for (const field of paramNames) {
    const fieldSchema = getOwn(shape, field);
    if (!fieldSchema) {
      const accepted = Object.keys(shape).join(', ');
      errors.push(`step "${call.tool}": unknown parameter "${field}" — accepted: ${accepted || '(none)'}`);
      continue;
    }

    const value = call.input[field]!;
    if (isTemplateValue(value)) continue;
    if (!fieldSchema.safeParse(value).success) {
      errors.push(`step "${call.tool}": parameter "${field}" value "${value}" does not match the expected type`);
    }
  }

  for (const group of getOwn(REQUIRED_ANY_OF, call.tool) ?? []) {
    if (!group.some((field) => paramNames.includes(field))) {
      errors.push(
        `step "${call.tool}": at least one of ${group.map((field) => `"${field}"`).join(' or ')} is required`,
      );
    }
  }

  return errors;
}

/**
 * Validate that every step calls a known tool (or workflow-only step) and passes arguments
 * that match its schema. Returns a list of human-readable error strings (empty = valid).
 */
export function validateWorkflowSteps(workflow: Workflow): string[] {
  const errors: string[] = [];

  for (const call of extractStepCalls(workflow)) {
    const schema = getOwn(STEP_SCHEMAS_BY_NAME, call.tool);
    if (!schema) {
      errors.push(`step "${call.tool}": no such tool`);
      continue;
    }
    errors.push(...validateStepParams(call, schema));
  }

  return errors;
}

/**
 * Full validation for a workflow about to be stored: template variables and tool calls.
 * Every path that persists a workflow must go through this, not one half of it.
 * Returns a list of human-readable error strings (empty = valid).
 */
export function validateWorkflow(workflow: Workflow, pattern: string | null | undefined): string[] {
  return [...validateWorkflowVariables(workflow, pattern), ...validateWorkflowSteps(workflow)];
}

/**
 * Validate that all {{expr}} references in a workflow are resolvable.
 * Returns a list of human-readable error strings (empty = valid).
 */
export function validateWorkflowVariables(workflow: Workflow, pattern: string | null | undefined): string[] {
  const errors: string[] = [];
  const capGroups = pattern ? countCapturingGroups(pattern) : 0;
  const askUserNames = extractAskUserNames(workflow);
  const stepOutputNames = extractStepOutputNames(workflow);

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

  for (const { expr, path } of extractExprs(workflow)) {
    const loc = path ? `${path}: ` : '';

    // Split off filter chain
    const pipeIdx = expr.indexOf('|');
    const varName = (pipeIdx === -1 ? expr : expr.slice(0, pipeIdx)).trim();
    const filterExpr = pipeIdx === -1 ? '' : expr.slice(pipeIdx + 1);

    // Validate variable name
    if (
      varName.startsWith('last_added_event.') ||
      varName.startsWith('last_mentioned_event.') ||
      varName.startsWith('t.')
    ) {
      // event context and i18n keys — always valid
    } else if (isConditionalExpr(varName)) {
      // Identify the variable portion before any operator for a helpful hint
      const hintVar = varName.split(/\s*(?:==|!=|\?|&&|\|\|)/)[0]?.trim() ?? varName;
      errors.push(
        `${loc}{{${expr}}} — conditional expressions are not supported; ` +
          `for equality: {{${hintVar}|eq("match","if_match","if_no_match")}}, ` +
          `for truthy/falsy: {{${hintVar}|ternary("if_true","if_false")}}`,
      );
    } else if (varName.startsWith('ask.')) {
      const askKey = varName.slice('ask.'.length);
      if (!askUserNames.has(askKey)) {
        errors.push(`${loc}{{${expr}}} — ask.${askKey} is not defined, no ask_user step with as: "${askKey}" found`);
      }
    } else {
      const captureMatch = CAPTURE_VAR_RE.exec(varName);
      if (captureMatch) {
        const n = Number.parseInt(captureMatch[1]!, 10);
        if (n < 1 || n > capGroups) {
          errors.push(
            `${loc}{{${expr}}} — capture group $${n} does not exist in pattern (pattern has ${capGroups} capturing group${capGroups === 1 ? '' : 's'})`,
          );
        }
      } else if (varName.startsWith('tool_outputs.')) {
        // {{tool_outputs.name}} or {{tool_outputs.name.field}} — step/ask_user output namespace
        const afterPrefix = varName.slice('tool_outputs.'.length);
        const outputName = afterPrefix.split('.')[0]!;
        const allOutputNames = new Set([...stepOutputNames, ...askUserNames]);
        if (!allOutputNames.has(outputName)) {
          errors.push(
            `${loc}{{${expr}}} — tool_outputs.${outputName} is not defined; ` +
              `no step with as: "${outputName}" found`,
          );
        }
      } else if (!ALLOWED_VARS.has(varName)) {
        errors.push(
          `${loc}{{${expr}}} — unknown variable "${varName}"; allowed: ${[...ALLOWED_VARS].join(', ')}, ` +
            `or $1..$N from pattern capture groups, ` +
            `or tool_outputs.<name> for step outputs (as: "name" on any step)`,
        );
      }
    }

    // Validate filter chain syntax and known filter names
    if (filterExpr) {
      let filters: FilterCall[];
      try {
        filters = parseFilterChain(filterExpr);
      } catch (e) {
        errors.push(`${loc}{{${expr}}} — invalid filter syntax — ${String(e)}`);
        continue;
      }
      for (const f of filters) {
        if (!KNOWN_FILTERS.has(f.name)) {
          errors.push(
            `${loc}{{${expr}}} — unknown filter "${f.name}" — known filters: ${[...KNOWN_FILTERS].join(', ')}`,
          );
        }
      }
    }
  }

  return errors;
}
