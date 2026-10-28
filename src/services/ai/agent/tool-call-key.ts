// Canonical identity of a tool call, and the message text the model sees for its result.
import type { z } from 'zod';
import { toolSchemas } from '../tool-schemas.ts';
import type { ToolResult } from '../types.ts';

/** Recursively sort object keys for stable serialization. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const sorted = Object.keys(value as { [key: string]: unknown }).sort();
  const parts = sorted.map((k) => `${JSON.stringify(k)}:${stableStringify((value as { [key: string]: unknown })[k])}`);
  return `{${parts.join(',')}}`;
}

interface ZodShapeField {
  safeParse: (value: unknown) => { success: boolean };
}

interface ZodObjectShape {
  shape: { [key: string]: ZodShapeField };
}

/** True when the schema's `.shape` exposes a field for `key` that accepts `null`. */
function fieldSchemaAcceptsNull(schema: z.ZodType | undefined, key: string): boolean {
  if (!schema || !('shape' in schema)) return false;
  const field = (schema as ZodObjectShape).shape[key];
  return field?.safeParse(null).success ?? false;
}

/**
 * The tool message the model sees. agentHint names the recovery route (which ID or tool to use
 * next), so a failure carries it too; without it the model is left with the bare error.
 */
export function toolResultContent(result: ToolResult): string {
  const body = result.success ? (result.output ?? 'OK') : `Error: ${result.error ?? result.output ?? 'Unknown error'}`;
  return result.agentHint ? `${body}\n[AGENT: ${result.agentHint}]` : body;
}

/**
 * Canonical dedup key for (tool name, input). Keys known to the tool schema
 * are extracted and sorted so `{a,b}` and `{b,a}` collide. Extra keys
 * injected by the model (e.g. `_nonce`) are stripped to prevent false key
 * divergence.
 */
export function toolCallKey(name: string, input: { [key: string]: unknown }): string {
  const schema = toolSchemas[name as keyof typeof toolSchemas];
  const knownKeys =
    schema && 'shape' in schema ? Object.keys((schema as { shape: { [key: string]: unknown } }).shape) : null;
  const parsed = schema?.safeParse(input);
  const filteredKeys = knownKeys
    ? Object.keys(input)
        .filter((k) => knownKeys.includes(k))
        .sort()
    : Object.keys(input).sort();
  // Absent (undefined) params are dropped so {query:"x"} and a call that never
  // mentioned start_date collide. But an EXPLICIT null is only dropped when the
  // schema field itself cannot mean null (a stray/invalid null from the model).
  // When the schema marks a field `.nullable()` (e.g. update_event's location,
  // end_at, description, recurrence_rule — "null removes it"), the explicit null
  // is kept in the canonical form so it stays distinct from field-omitted: a call
  // that clears a field must never dedup-collide with an earlier call that left
  // it untouched.
  const canonical: { [key: string]: unknown } = {};
  for (const k of filteredKeys) {
    const value = input[k];
    if (value === undefined) continue;
    if (value === null) {
      if (fieldSchemaAcceptsNull(schema, k)) canonical[k] = null;
      continue;
    }
    canonical[k] =
      parsed?.success && parsed.data !== null && typeof parsed.data === 'object' ? Reflect.get(parsed.data, k) : value;
  }
  return `${name}:${stableStringify(canonical)}`;
}

export const DUPLICATE_MARKER =
  'DUPLICATE: you already called this tool with identical arguments earlier in this turn. ' +
  'Use the previous result. Do NOT call this tool again — respond to the user with a final answer ' +
  'or call a different tool.';
