/**
 * Source model of the intent documentation: validates the seed, metadata and lineage tables and builds the
 * catalogue every renderer consumes. It never opens a database and never imports the mutating seeder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { auditDefinition } from '../src/services/intent/catalog-audit.ts';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { seedFingerprint } from '../src/services/intent/rule-fingerprint.ts';
import {
  type CanonicalMetadata,
  canonicalMetadata,
  type LegacyDispositionEntry,
  legacyDisposition,
  seedIntents,
} from '../src/services/intent/seed-catalog.ts';
import { BindingSchema } from '../src/services/intent/workflow-bindings.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { jsonCodec } from '../src/utils/json-codec.ts';
import { bindingTypeTitles, canonicalTitles, categoryTitles, legacyTitles, riskTitles } from './intent-doc-labels.ts';

export const DOCS_DIRECTORY = resolve(import.meta.dir, '../docs/intents');
const SEED_SOURCE_PATH = 'src/services/intent/seed-catalog.ts';
export const LINEAGE_FILE = 'db-lineage.json';

type Seed = (typeof seedIntents)[number];
export type Disposition = LegacyDispositionEntry['disposition'];
export const DISPOSITIONS: Disposition[] = ['merge', 'rewrite', 'retire'];

// ─── source data ────────────────────────────────────────────────────────────

const TOOL_NAME = /^[a-z][a-z0-9_]{0,80}$/;
const KEY_NAME = /^[a-z0-9_.-]{1,80}$/i;
const DatabaseLineageEntry = z
  .object({
    id: z.number().int().positive(),
    oldName: z.string().regex(KEY_NAME),
    oldKey: z.string().regex(KEY_NAME),
    status: z.string().regex(/^[a-z_]{1,32}$/),
    disposition: z.enum(['merge', 'rewrite', 'retire']),
    target: z.string().nullable(),
    reason: z.string().min(1).max(480),
    previousTools: z.array(z.string().regex(TOOL_NAME)).max(16),
  })
  .strict();
const DatabaseLineageFile = z
  .object({
    schemaVersion: z.literal(1),
    cohort: z.string().regex(KEY_NAME),
    capturedAt: z.string().max(40),
    counts: z.object({ merge: z.number(), rewrite: z.number(), retire: z.number() }).strict(),
    entries: z.array(DatabaseLineageEntry),
    note: z.string().max(600),
  })
  .strict()
  .refine((file) => new Set(file.entries.map((entry) => entry.id)).size === file.entries.length, 'Duplicate legacy id')
  .refine(
    (file) => DISPOSITIONS.every((d) => file.counts[d] === file.entries.filter((e) => e.disposition === d).length),
    'Declared counts differ from the entries',
  );
export type DatabaseLineage = z.infer<typeof DatabaseLineageFile>;

/** The cohort recorded from a live database, sanitized to generic meaning; absent until provided. */
export function readDatabaseLineage(path = resolve(DOCS_DIRECTORY, LINEAGE_FILE)): DatabaseLineage | null {
  if (!existsSync(path)) return null;
  const parsed = jsonCodec(DatabaseLineageFile).safeParse(readFileSync(path, 'utf8'));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid ${LINEAGE_FILE}: ${problems.join('; ')}`);
  }
  return parsed.data;
}

export interface CatalogueSource {
  seed: readonly Seed[];
  metadata: readonly CanonicalMetadata[];
  lineage: readonly LegacyDispositionEntry[];
  databaseLineage: DatabaseLineage | null;
}

export function currentSource(): CatalogueSource {
  return {
    seed: seedIntents,
    metadata: canonicalMetadata,
    lineage: legacyDisposition,
    databaseLineage: readDatabaseLineage(),
  };
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => seen.size === seen.add(value).size);
}

function assertNames(source: CatalogueSource): void {
  const [duplicate] = duplicates(source.seed.map((rule) => rule.canonical_name));
  if (duplicate) throw new Error(`Duplicate intent key: ${duplicate}`);
  const [metaDuplicate] = duplicates(source.metadata.map((meta) => meta.name));
  if (metaDuplicate) throw new Error(`Duplicate metadata key: ${metaDuplicate}`);
  const names = new Set(source.seed.map((rule) => rule.canonical_name));
  const missing = source.metadata.filter((meta) => !names.has(meta.name)).map((meta) => meta.name);
  const undescribed = source.seed.filter((rule) => !source.metadata.some((meta) => meta.name === rule.canonical_name));
  if (missing.length || undescribed.length)
    throw new Error(
      `Seed and metadata differ: ${[...missing, ...undescribed.map((rule) => rule.canonical_name)].join(', ')}`,
    );
}

function assertLabels(source: CatalogueSource): void {
  for (const meta of source.metadata) {
    if (!canonicalTitles[meta.name]) throw new Error(`Missing Russian title for ${meta.name}`);
    if (!categoryTitles[meta.category]) throw new Error(`Missing category label for ${meta.category}`);
    if (!riskTitles[meta.risk]) throw new Error(`Missing risk label for ${meta.risk}`);
  }
  for (const entry of source.lineage)
    if (!legacyTitles[entry.oldKey]) throw new Error(`Missing Russian title for earlier rule ${entry.oldKey}`);
}

function assertLineage(source: CatalogueSource): void {
  const [duplicate] = duplicates(source.lineage.map((entry) => entry.oldKey));
  if (duplicate) throw new Error(`Duplicate lineage key: ${duplicate}`);
  const names = new Set(source.seed.map((rule) => rule.canonical_name));
  for (const entry of source.lineage) {
    if (entry.disposition === 'retire' ? entry.target !== null : !entry.target || !names.has(entry.target))
      throw new Error(`Lineage ${entry.oldKey} points at an unknown target`);
  }
  for (const record of source.databaseLineage?.entries ?? [])
    if (record.disposition === 'retire' ? record.target !== null : !record.target || !names.has(record.target))
      throw new Error(`Database lineage ${record.id} points at an unknown target`);
}

// ─── entries ────────────────────────────────────────────────────────────────

interface Probe {
  example: string;
  result: string;
}

export interface CatalogueEntry {
  name: string;
  title: string;
  sourceTitle: string;
  category: string;
  risk: string;
  origin: 'canonical';
  source: string;
  deployed: null;
  examples: string[];
  negativeExamples: string[];
  invalidInputExamples: string[];
  pattern: string;
  workflow: object;
  tools: string[];
  bindingTypes: string[];
  notes: string | null;
  predecessors: { key: string; title: string; disposition: Disposition }[];
  issues: string[];
  audit: ReturnType<typeof auditDefinition>;
  matching: Probe[];
  negativeMatching: Probe[];
  invalidInputMatching: Probe[];
}

function loadMatcher(seed: readonly Seed[]): IntentMatcher {
  const matcher = new IntentMatcher();
  matcher.load(
    seed.map((rule, index) => ({
      id: index + 1,
      canonical_name: rule.canonical_name,
      phrases: JSON.stringify(rule.phrases),
      trigger_words: JSON.stringify(rule.trigger_words),
      pattern: rule.pattern,
      workflow: JSON.stringify(rule.workflow),
      format: 'text',
      status: 'approved' as const,
      source_message: rule.source_message,
      created_at: '',
    })),
  );
  return matcher;
}

/** `own`: routed to this rule; `different`: routed to another rule; anything else is the abstention reason. */
function positiveProbe(matcher: IntentMatcher, id: number, example: string): Probe {
  const decision = matcher.explain(example);
  if (decision.kind === 'abstain') return { example, result: decision.reason };
  return { example, result: decision.result.intentId === id ? 'own' : 'different' };
}

function negativeProbe(matcher: IntentMatcher, example: string): Probe {
  return { example, result: matcher.explain(example).kind === 'abstain' ? 'fallthrough' : 'matched' };
}

function bindingTypesOf(workflow: object): string[] {
  const parsed = WorkflowSchema.parse(workflow);
  return [...new Set(Object.values(parsed.version === 2 ? (parsed.bindings ?? {}) : {}).map((b) => b.type))];
}

function issuesOf(audit: CatalogueEntry['audit'], matching: Probe[], negatives: Probe[], invalid: Probe[]): string[] {
  return [
    ...(audit.schemaValid ? [] : ['schema']),
    ...(audit.contractErrors ? ['tool_contract'] : []),
    ...(matching.some((probe) => probe.result !== 'own') ? ['positive_routing'] : []),
    ...(negatives.some((probe) => probe.result === 'own') ? ['negative_matched'] : []),
    ...(invalid.some((probe) => probe.result !== 'own') ? ['invalid_input_routing'] : []),
  ];
}

function buildEntry(
  rule: Seed,
  meta: CanonicalMetadata,
  id: number,
  matcher: IntentMatcher,
  lineage: readonly LegacyDispositionEntry[],
): CatalogueEntry {
  const examples = [...new Set([...meta.examples.synthetic, ...meta.examples.empirical, rule.source_message])];
  const matching = examples.map((example) => positiveProbe(matcher, id, example));
  const negativeMatching = meta.negativeExamples.map((example) => negativeProbe(matcher, example));
  const invalidInputMatching = meta.invalidInputExamples.map((example) => positiveProbe(matcher, id, example));
  const audit = auditDefinition(rule);
  return {
    name: rule.canonical_name,
    title: canonicalTitles[meta.name]!,
    sourceTitle: meta.title,
    category: meta.category,
    risk: meta.risk,
    origin: 'canonical',
    source: SEED_SOURCE_PATH,
    deployed: null,
    examples,
    negativeExamples: [...meta.negativeExamples],
    invalidInputExamples: [...meta.invalidInputExamples],
    pattern: rule.pattern,
    workflow: rule.workflow,
    tools: [...meta.tools],
    bindingTypes: bindingTypesOf(rule.workflow),
    notes: meta.notes ?? null,
    predecessors: lineage
      .filter((entry) => entry.target === rule.canonical_name)
      .map((entry) => ({ key: entry.oldKey, title: legacyTitles[entry.oldKey]!, disposition: entry.disposition }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    issues: issuesOf(audit, matching, negativeMatching, invalidInputMatching),
    audit,
    matching,
    negativeMatching,
    invalidInputMatching,
  };
}

// ─── catalogue ──────────────────────────────────────────────────────────────

interface DispositionCounts {
  total: number;
  merge: number;
  rewrite: number;
  retire: number;
}

export interface CatalogueLineage {
  source: DispositionCounts & {
    distinctTargets: number;
    entries: { oldKey: string; oldTitle: string; disposition: Disposition; target: string | null; reason: string }[];
  };
  database: DispositionCounts & { provided: boolean; entries: DatabaseLineage['entries'] };
}

export interface Catalogue {
  schemaVersion: number;
  fingerprint: string;
  runtimeVerification: null;
  engine: { document: string; bindingTypes: { type: string; title: string; uses: number }[] };
  counts: { rules: number; categories: { [key: string]: number }; risks: { [key: string]: number }; tools: number };
  entries: CatalogueEntry[];
  lineage: CatalogueLineage;
}

export function tally(values: readonly string[]): { [key: string]: number } {
  const counts: { [key: string]: number } = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function bindingTypeNames(): string[] {
  return BindingSchema.options.map((option) => option.shape.type.value);
}

function buildLineage(source: CatalogueSource): CatalogueLineage {
  const counts = tally(source.lineage.map((entry) => entry.disposition));
  const targets = new Set(source.lineage.flatMap((entry) => (entry.target ? [entry.target] : [])));
  return {
    source: {
      total: source.lineage.length,
      merge: counts.merge ?? 0,
      rewrite: counts.rewrite ?? 0,
      retire: counts.retire ?? 0,
      distinctTargets: targets.size,
      entries: source.lineage.map((entry) => ({
        oldKey: entry.oldKey,
        oldTitle: legacyTitles[entry.oldKey]!,
        disposition: entry.disposition,
        target: entry.target,
        reason: entry.reason,
      })),
    },
    database: {
      provided: source.databaseLineage !== null,
      total: source.databaseLineage?.entries.length ?? 0,
      merge: source.databaseLineage?.counts.merge ?? 0,
      rewrite: source.databaseLineage?.counts.rewrite ?? 0,
      retire: source.databaseLineage?.counts.retire ?? 0,
      entries: source.databaseLineage?.entries ?? [],
    },
  };
}

export function buildCatalogue(source: CatalogueSource = currentSource()): Catalogue {
  assertNames(source);
  assertLabels(source);
  assertLineage(source);
  const matcher = loadMatcher(source.seed);
  const entries = source.seed.map((rule, index) =>
    buildEntry(
      rule,
      source.metadata.find((meta) => meta.name === rule.canonical_name)!,
      index + 1,
      matcher,
      source.lineage,
    ),
  );
  const usage = tally(entries.flatMap((entry) => entry.bindingTypes));
  const catalogue: Catalogue = {
    schemaVersion: 2,
    fingerprint: seedFingerprint(source.seed),
    runtimeVerification: null,
    engine: {
      document: 'engine.md',
      bindingTypes: bindingTypeNames().map((type) => ({
        type,
        title: bindingTypeTitles[type] ?? type,
        uses: usage[type] ?? 0,
      })),
    },
    counts: {
      rules: entries.length,
      categories: tally(entries.map((entry) => entry.category)),
      risks: tally(entries.map((entry) => entry.risk)),
      tools: new Set(entries.flatMap((entry) => entry.tools)).size,
    },
    entries,
    lineage: buildLineage(source),
  };
  return catalogue;
}
