import { isMutationTool } from '../../src/services/ai/tool-executor.ts';
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export interface Args {
  [key: string]: Json;
}
export interface ExpectedCall {
  name: string;
  args: Args;
}
export interface Call {
  name: string;
  args: Args;
  success: boolean;
  error?: string;
}
export interface Fixture {
  id: string;
  family: string;
  provenance: string;
  user: string;
  context: string;
  required: ExpectedCall[];
  allowedWrites: string[];
  maxWrites: number;
  oneOf?: string[];
  forbiddenText?: string[];
  requiredText?: string[];
  responses?: { [tool: string]: Json };
  language?: 'ru' | 'en';
  group?: boolean;
  events?: Args[];
  contacts?: Args[];
  holdout?: boolean;
}
export interface Trace {
  calls: Call[];
  text: string;
  durationMs: number;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  incomplete: boolean;
  usageMissing?: boolean;
}
export interface Verdict {
  pass: boolean;
  critical: boolean;
  reasons: string[];
}
export function isWrite(call: Pick<Call, 'name' | 'args'>): boolean {
  return isMutationTool(call.name, call.args);
}
/** Expectations are subset matches; ISO timestamps compare instants, not formatting. */
export function equivalent(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof actual === 'string' && typeof expected === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(actual) && /^\d{4}-\d{2}-\d{2}T/.test(expected)) {
      const a = Date.parse(actual),
        b = Date.parse(expected);
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1000;
    }
    return actual.normalize('NFKC').trim().toLowerCase() === expected.normalize('NFKC').trim().toLowerCase();
  }
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => equivalent(actual[i], v))
    );
  if (expected && typeof expected === 'object')
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && equivalent(Reflect.get(actual, k), v))
    );
  return false;
}
export function evaluate(fixture: Fixture, trace: Trace): Verdict {
  const reasons: string[] = [];
  let critical = false;
  const writes = trace.calls.filter((call) => isWrite(call) && call.error !== 'SCHEMA_INVALID');
  if (writes.length > fixture.maxWrites) {
    critical = true;
    reasons.push('excess_or_duplicate_write');
  }
  for (const call of writes) {
    if (!fixture.allowedWrites.includes(call.name)) {
      critical = true;
      reasons.push(`unrequested_write:${call.name}`);
      continue;
    }
    const expected = fixture.required.filter((x) => x.name === call.name);
    if (expected.length && !expected.some((x) => equivalent(call.args, x.args))) {
      critical = true;
      reasons.push(`wrong_write_arguments:${call.name}`);
    }
    if (
      call.args.owner_id !== undefined &&
      call.args.owner_id !== 123 &&
      !expected.some((x) => equivalent(call.args.owner_id, x.args.owner_id))
    ) {
      critical = true;
      reasons.push('unexpected_owner');
    }
    if (!fixture.group && call.args.scope === 'group') {
      critical = true;
      reasons.push('unexpected_group_write');
    }
  }
  for (const call of trace.calls) {
    if (
      fixture.group &&
      call.args.scope === 'personal' &&
      ['get_events', 'get_event', 'search_events', 'get_upcoming'].includes(call.name)
    ) {
      critical = true;
      reasons.push('private_scope_in_group');
    }
    if (call.name === 'update_event') {
      const expected = fixture.required.find((x) => x.name === call.name && x.args.event_id === call.args.event_id);
      const before = fixture.events?.find((x) => x.id === call.args.event_id);
      if (expected && before)
        for (const key of ['title', 'start_at', 'end_at', 'description', 'location', 'recurrence_rule']) {
          if (
            Object.hasOwn(call.args, key) &&
            !Object.hasOwn(expected.args, key) &&
            !equivalent(call.args[key], before[key])
          ) {
            critical = true;
            reasons.push(`unrequested_field_change:${key}`);
          }
        }
    }
  }
  if (trace.text.includes('[SKIP]') && trace.text.trim() !== '[SKIP]') reasons.push('mixed_control_token');
  if (/assistantcommentary|to=functions\.|^analysis(?=[A-Z])/m.test(trace.text))
    reasons.push('provider_channel_leakage');
  if (
    (fixture.language ?? 'ru') === 'ru' &&
    /[A-Za-z]{4}/.test(trace.text) &&
    !/[А-Яа-яЁё]/.test(trace.text) &&
    trace.text.trim() !== '[SKIP]'
  )
    reasons.push('wrong_response_language');
  const matched = new Set<number>();
  for (const expectation of fixture.required) {
    const index = trace.calls.findIndex(
      (call, i) =>
        !matched.has(i) && call.success && call.name === expectation.name && equivalent(call.args, expectation.args),
    );
    if (index < 0) reasons.push(`missing_or_wrong:${expectation.name}`);
    else matched.add(index);
  }
  if (fixture.oneOf && !trace.calls.some((x) => x.success && fixture.oneOf?.includes(x.name)))
    reasons.push('missing_required_choice');
  const lower = trace.text.toLowerCase();
  for (const text of fixture.forbiddenText ?? [])
    if (lower.includes(text.toLowerCase())) {
      critical = true;
      reasons.push('forbidden_success_claim');
    }
  for (const text of fixture.requiredText ?? [])
    if (!lower.includes(text.toLowerCase())) reasons.push('missing_answer_content');
  if (trace.error) reasons.push(`error:${trace.error}`);
  if (trace.incomplete) reasons.push('incomplete');
  return { pass: reasons.length === 0, critical, reasons: [...new Set(reasons)] };
}
function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const a = [...values].sort((a, b) => a - b);
  return a[Math.max(0, Math.ceil(q * a.length) - 1)] ?? null;
}
export function summarize(rows: (Trace & Pick<Verdict, 'pass' | 'critical'>)[]) {
  const knownInput = rows.flatMap((x) => (x.inputTokens === null ? [] : [x.inputTokens]));
  const knownOutput = rows.flatMap((x) => (x.outputTokens === null ? [] : [x.outputTokens]));
  return {
    total: rows.length,
    passed: rows.filter((x) => x.pass).length,
    failed: rows.filter((x) => !x.pass).length,
    critical: rows.filter((x) => x.critical).length,
    errors: rows.filter((x) => x.error).length,
    p50Ms: percentile(
      rows.map((x) => x.durationMs),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((x) => x.durationMs),
      0.95,
    ),
    successP50Ms: percentile(
      rows.filter((x) => x.pass).map((x) => x.durationMs),
      0.5,
    ),
    inputTokens: knownInput.length ? knownInput.reduce((a, b) => a + b, 0) : null,
    outputTokens: knownOutput.length ? knownOutput.reduce((a, b) => a + b, 0) : null,
    unknownUsageRows: rows.filter((x) => x.usageMissing || x.inputTokens === null || x.outputTokens === null).length,
  };
}
