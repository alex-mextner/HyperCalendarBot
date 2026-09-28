// Fingerprints of intent rule sets and the codecs that read stored rules back. A leaf module
// (zod, node:crypto and the JSON codec only) so the migration layer can verify the registry
// without loading the matcher. The fingerprint must stay byte-compatible with the manifests
// already written in production: same fields, raw workflow JSON (never a schema-parsed value),
// `pattern`/`source_message` defaulting to '' and `trigger_words` to [] exactly as stored rows did.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Intent } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** One rule as it is fingerprinted: the definition, without id, format or status. */
export const RuleDefinitionSchema = z.object({
  canonical_name: z.string(),
  pattern: z.string(),
  workflow: JsonValueSchema,
  phrases: z.array(z.string()),
  trigger_words: z.array(z.string()),
  source_message: z.string(),
});
export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

/** Any rule-shaped input; `workflow` is `unknown` so source seeds typed `object` fit too. */
export interface FingerprintInput {
  canonical_name: string;
  pattern: string;
  workflow: unknown;
  phrases: readonly string[];
  trigger_words: readonly string[];
  source_message: string;
}

/** Only the fingerprinted fields; ids, format and status never enter a fingerprint or a revision. */
const definitionFields = (rule: FingerprintInput) => ({
  canonical_name: rule.canonical_name,
  pattern: rule.pattern,
  workflow: rule.workflow,
  phrases: rule.phrases,
  trigger_words: rule.trigger_words,
  source_message: rule.source_message,
});

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

export const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');

/** Per-rule digests by name: the one definition-equality both revision diffs and provenance use. */
export const digestsByName = (rules: readonly RuleDefinition[]): Map<string, string> =>
  new Map(rules.map((rule) => [rule.canonical_name, digest(definitionFields(rule))]));

export function seedFingerprint(seed: readonly FingerprintInput[]): string {
  return digest(seed.map(definitionFields).sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)));
}

const WorkflowJsonCodec = jsonCodec(JsonValueSchema);
const StringListCodec = jsonCodec(z.array(z.string()));
export const RuleListCodec = jsonCodec(z.array(RuleDefinitionSchema));

/** JSON-normalized definitions; throws when a workflow is not representable as JSON. */
export function toRuleDefinitions(rules: readonly FingerprintInput[]): RuleDefinition[] {
  return RuleListCodec.parse(JSON.stringify(rules.map(definitionFields)));
}

export type StoredRuleRow = Pick<
  Intent,
  'id' | 'canonical_name' | 'pattern' | 'workflow' | 'phrases' | 'trigger_words' | 'source_message'
>;

/** A stored row as a rule definition, or null when any JSON column does not decode. */
export function ruleFromRow(row: StoredRuleRow): RuleDefinition | null {
  const workflow = WorkflowJsonCodec.safeParse(row.workflow);
  const phrases = StringListCodec.safeParse(row.phrases);
  const triggers = StringListCodec.safeParse(row.trigger_words ?? '[]');
  if (!workflow.success || !phrases.success || !triggers.success) return null;
  return {
    canonical_name: row.canonical_name,
    pattern: row.pattern ?? '',
    workflow: workflow.data,
    phrases: phrases.data,
    trigger_words: triggers.data,
    source_message: row.source_message ?? '',
  };
}

/**
 * The identity of one stored rule a run executes: its definition (every field a revision diff
 * compares, so any revision change alters it) plus the response format the run's output is
 * rendered with. Null when a JSON column does not decode.
 */
export function ruleFingerprint(row: StoredRuleRow & Pick<Intent, 'format'>): string | null {
  const rule = ruleFromRow(row);
  return rule ? digest({ ...rule, format: row.format }) : null;
}
