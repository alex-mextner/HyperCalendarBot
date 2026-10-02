// Bounds and redacts learning input before it is persisted or handed to a worker. Only
// credential-shaped values are removed: event IDs, dates and ordinary numbers survive.
import type { EnqueueInput, JsonObject, JsonValue } from './schemas.ts';
import { EnqueueInputSchema } from './schemas.ts';

export const SAMPLE_BOUNDS = {
  requestChars: 4000,
  previousAiResponseChars: 8000,
  toolCalls: 24,
  toolResults: 24,
  toolResultChars: 4000,
  recentMessages: 12,
  recentMessageChars: 1500,
  stringChars: 2000,
  arrayItems: 32,
  objectKeys: 48,
  depth: 6,
} as const;

const REDACTED = '[REDACTED]';

/** Object keys whose values are credentials regardless of content. */
const SENSITIVE_KEY =
  /^(authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|token|bot[-_]?token|auth[-_]?key|session[-_]?string|private[-_]?key)$/i;

const TEXT_RULES: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  [
    /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)(\s*[:=]\s*)("?)[^\s"',;&]+/gi,
    `$1$2$3${REDACTED}`,
  ],
  [/([?&](?:token|access_token|refresh_token|api_key|key|code|sig|signature|auth)=)[^&\s#"']+/gi, `$1${REDACTED}`],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [
    /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})/g,
    REDACTED,
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
];

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_RULES) result = result.replace(pattern, replacement);
  return result;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max}]`;
}

/** Bounded, redacted copy of a JSON value. Structure deeper than the bound is summarized. */
export function redactValue(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === 'string') return truncate(redactText(value), SAMPLE_BOUNDS.stringChars);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= SAMPLE_BOUNDS.depth) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, SAMPLE_BOUNDS.arrayItems).map((item) => redactValue(item, depth + 1));
  return redactObject(value, depth);
}

function redactObject(value: JsonObject, depth: number): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value).slice(0, SAMPLE_BOUNDS.objectKeys))
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, depth + 1);
  return out;
}

export interface SanitizedSample {
  actorId: number;
  chatId: number;
  messageId: number | null;
  request: string;
  previousAiResponse: string;
  toolCalls: { name: string; input: JsonObject }[];
  toolResults: { success: boolean; output?: string }[];
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
  eligible: boolean;
}

/** Validates and sanitizes one interaction. Oversized parts are truncated, never rejected. */
export function sanitizeEnqueueInput(input: EnqueueInput): SanitizedSample {
  const parsed = EnqueueInputSchema.parse(input);
  const toolCalls = parsed.toolCalls.slice(0, SAMPLE_BOUNDS.toolCalls).map((call) => ({
    name: call.name.slice(0, 64),
    input: redactObject(call.input, 0),
  }));
  return {
    actorId: parsed.actorId,
    chatId: parsed.chatId,
    messageId: parsed.messageId ?? null,
    request: truncate(redactText(parsed.request.trim()), SAMPLE_BOUNDS.requestChars),
    previousAiResponse: truncate(redactText(parsed.previousAiResponse), SAMPLE_BOUNDS.previousAiResponseChars),
    toolCalls,
    toolResults: parsed.toolResults.slice(0, SAMPLE_BOUNDS.toolResults).map((result) => ({
      success: result.success,
      ...(result.output === undefined
        ? {}
        : { output: truncate(redactText(result.output), SAMPLE_BOUNDS.toolResultChars) }),
    })),
    recentMessages: parsed.recentMessages.slice(-SAMPLE_BOUNDS.recentMessages).map((message) => ({
      role: message.role,
      text: truncate(redactText(message.text), SAMPLE_BOUNDS.recentMessageChars),
    })),
    eligible: parsed.evidenceOnly !== true && toolCalls.length > 0,
  };
}

/** Iterative depth probe run before recursive schema parsing of untrusted JSON. */
export function jsonDepthWithin(value: unknown, maxDepth: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > maxDepth) return false;
    if (typeof item.value === 'object' && item.value !== null)
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}
