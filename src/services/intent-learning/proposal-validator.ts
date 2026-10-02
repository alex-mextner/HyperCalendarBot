// Native validation of a proposal against the live registry. Nothing a worker or reviewer claims is
// trusted: cardinality, workflow schema, whole-message matchers and routing collisions are re-checked.
import type { RegistryRevisionPlan } from '../../database/repositories/intent.repository.ts';
import type { Intent } from '../../database/types.ts';
import { IntentMatcher } from '../intent/intent-matcher.ts';
import { normalize } from '../intent/normalizer.ts';
import { canonicalMetadata } from '../intent/seed-catalog.ts';
import { readWorkflowVersion } from '../intent/workflow-input.ts';
import { type Workflow, WorkflowSchema } from '../intent/workflow-schema.ts';
import { validateWorkflow } from '../intent/workflow-validator.ts';
import { PROPOSAL_LIMITS } from './constants.ts';
import { type RegistryRule, type RegistrySnapshot, registryFingerprint } from './registry.ts';
import type { Comparison, IntentDraft, ProposalOperation } from './schemas.ts';

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  baseFingerprint: string;
  /** Fingerprint of the registry after activation; empty when invalid. */
  targetFingerprint: string;
  /** Digest of every affected active rule; a rebase needs it unchanged. */
  sourceDigest: string;
  affected: string[];
  insert: RegistryRevisionPlan['insert'];
}

export interface ValidationSample {
  sampleId: number;
  request: string;
}

const DRAFT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,)/;
const DRAFT_ID_BASE = 1_000_000_000;

const CARDINALITY: Record<ProposalOperation['kind'], (sources: number, intents: number) => boolean> = {
  create: (sources, intents) => sources === 0 && intents >= 1,
  generalize: (sources, intents) => sources === 1 && intents === 1,
  consolidate: (sources, intents) => sources >= 2 && intents === 1,
  retire: (sources, intents) => sources >= 1 && intents === 0,
};

function checkShape(operations: ProposalOperation[]): string[] {
  const errors: string[] = [];
  if (operations.length < 1 || operations.length > PROPOSAL_LIMITS.operations)
    errors.push(`A proposal needs 1..${PROPOSAL_LIMITS.operations} operations`);
  const rules = operations.reduce((sum, op) => sum + op.intents.length, 0);
  if (rules > PROPOSAL_LIMITS.rules) errors.push(`A proposal may carry at most ${PROPOSAL_LIMITS.rules} rules`);
  operations.forEach((op, index) => {
    if (!CARDINALITY[op.kind](op.sourceNames.length, op.intents.length))
      errors.push(
        `Operation ${index} (${op.kind}) has ${op.sourceNames.length} sources and ${op.intents.length} intents`,
      );
  });
  return errors;
}

function checkSources(operations: ProposalOperation[], registry: RegistrySnapshot): string[] {
  const errors: string[] = [];
  const active = new Set(registry.rules.map((rule) => rule.canonical_name));
  const seen = new Set<string>();
  for (const name of operations.flatMap((op) => op.sourceNames)) {
    if (!active.has(name)) errors.push(`Source ${name} is not an active intent`);
    if (seen.has(name)) errors.push(`Source ${name} is affected more than once`);
    seen.add(name);
  }
  return errors;
}

function checkDraftNames(operations: ProposalOperation[], registry: RegistrySnapshot): string[] {
  const errors: string[] = [];
  const affected = new Set(operations.flatMap((op) => op.sourceNames));
  const taken = new Set([
    ...registry.rules.map((rule) => rule.canonical_name).filter((name) => !affected.has(name)),
    ...registry.reservedNames,
  ]);
  const drafted = new Set<string>();
  for (const draft of operations.flatMap((op) => op.intents)) {
    const name = draft.canonical_name;
    if (!DRAFT_NAME.test(name)) errors.push(`${name}: names are lowercase dotted snake_case`);
    if (taken.has(name)) errors.push(`${name}: name is held by an unaffected intent`);
    if (drafted.has(name)) errors.push(`${name}: name is drafted twice`);
    if (name.startsWith('basis.') && !affected.has(name))
      errors.push(`${name}: new rules cannot enter the basis namespace; only a replaced basis name may be kept`);
    drafted.add(name);
  }
  return errors;
}

function checkPattern(name: string, pattern: string): string[] {
  const errors: string[] = [];
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$'))
    errors.push(`${name}: pattern must be anchored to the whole message (^...$)`);
  if (NESTED_QUANTIFIER.test(pattern)) errors.push(`${name}: nested quantifiers are not allowed`);
  try {
    new RegExp(pattern, 'di');
  } catch {
    errors.push(`${name}: pattern does not compile`);
  }
  return errors;
}

/** Whole-message constraints apply to every draft, whatever its name. */
function checkDraft(draft: IntentDraft): { errors: string[]; workflow: Workflow | null } {
  const name = draft.canonical_name;
  const errors = checkPattern(name, draft.pattern);
  if (readWorkflowVersion(draft.workflow) !== 2) errors.push(`${name}: explicit workflow version 2 is required`);
  const parsed = WorkflowSchema.safeParse(draft.workflow);
  if (!parsed.success) return { errors: [...errors, `${name}: workflow does not match the schema`], workflow: null };
  if (errors.length === 0) errors.push(...validateWorkflow(parsed.data, draft.pattern).map((e) => `${name}: ${e}`));
  if (draft.phrases.some((phrase) => !normalize(phrase))) errors.push(`${name}: empty phrase after normalization`);
  if (draft.trigger_words.some((word) => !normalize(word))) errors.push(`${name}: empty trigger word`);
  return { errors, workflow: parsed.data };
}

function asIntent(rule: Omit<RegistryRule, 'format'>): Intent {
  return {
    id: rule.id,
    canonical_name: rule.canonical_name,
    phrases: JSON.stringify(rule.phrases),
    trigger_words: JSON.stringify(rule.trigger_words),
    pattern: rule.pattern || null,
    workflow: JSON.stringify(rule.workflow),
    format: 'text',
    status: 'approved',
    source_message: rule.source_message,
    created_at: '2000-01-01 00:00:00',
  };
}

function matcherOf(rules: Omit<RegistryRule, 'format'>[]): IntentMatcher {
  const matcher = new IntentMatcher();
  matcher.load(rules.map(asIntent));
  return matcher;
}

function examplesOf(rule: { phrases: string[]; source_message: string }): string[] {
  return [...new Set([...rule.phrases, rule.source_message].filter(Boolean))];
}

export function workflowTools(workflow: Workflow): string[] {
  const calls = 'steps' in workflow ? workflow.steps.map((step) => step.call) : workflow.tools.map((tool) => tool.name);
  return [...new Set(calls.filter((call): call is string => typeof call === 'string'))];
}

interface Candidate {
  drafts: (RegistryRule & { op: ProposalOperation })[];
  unaffected: RegistryRule[];
  baseline: IntentMatcher;
  next: IntentMatcher;
}

function buildCandidate(operations: ProposalOperation[], registry: RegistrySnapshot): Candidate {
  const affected = new Set(operations.flatMap((op) => op.sourceNames));
  const unaffected = registry.rules.filter((rule) => !affected.has(rule.canonical_name));
  const drafts = operations.flatMap((op) => op.intents.map((draft) => ({ draft, op })));
  const draftRules = drafts.map(({ draft, op }, index) => ({
    id: DRAFT_ID_BASE + index,
    canonical_name: draft.canonical_name,
    pattern: draft.pattern,
    workflow: draft.workflow,
    phrases: draft.phrases,
    trigger_words: draft.trigger_words,
    source_message: draft.source_message,
    format: draft.format ?? 'text',
    op,
  }));
  return {
    drafts: draftRules,
    unaffected,
    baseline: matcherOf(registry.rules),
    next: matcherOf([...unaffected, ...draftRules]),
  };
}

function checkRouting(candidate: Candidate, registry: RegistrySnapshot): string[] {
  const errors: string[] = [];
  const { baseline, next } = candidate;
  for (const draft of candidate.drafts)
    for (const example of examplesOf(draft))
      if (next.match(example)?.intentId !== draft.id)
        errors.push(`${draft.canonical_name}: example "${example}" does not route uniquely to it`);
  for (const rule of candidate.unaffected)
    for (const example of examplesOf(rule))
      if (baseline.match(example)?.intentId === rule.id && next.match(example)?.intentId !== rule.id)
        errors.push(`Active ${rule.canonical_name} loses its example "${example}"`);
  for (const draft of candidate.drafts)
    for (const sourceName of draft.op.sourceNames) {
      const source = registry.rules.find((rule) => rule.canonical_name === sourceName);
      if (!source || draft.op.kind === 'create') continue;
      for (const example of examplesOf(source))
        if (baseline.match(example)?.intentId === source.id && next.match(example)?.intentId !== draft.id)
          errors.push(`${draft.canonical_name}: replaced ${sourceName} example "${example}" is no longer covered`);
    }
  const draftIds = new Set(candidate.drafts.map((draft) => draft.id));
  for (const meta of canonicalMetadata)
    for (const negative of meta.negativeExamples) {
      const routed = next.match(negative)?.intentId;
      if (routed !== undefined && draftIds.has(routed))
        errors.push(`Known negative "${negative}" of ${meta.name} now routes to a drafted rule`);
    }
  return errors;
}

function checkComparisons(
  candidate: Candidate,
  comparisons: readonly Comparison[],
  samples: readonly ValidationSample[],
  toolsByDraft: Map<string, string[]>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(samples.map((sample) => [sample.sampleId, sample]));
  const draftById = new Map(candidate.drafts.map((draft) => [draft.id, draft]));
  for (const comparison of comparisons) {
    const sample = byId.get(comparison.sampleId);
    if (!sample) {
      errors.push(`Comparison references sample ${comparison.sampleId} outside this job`);
      continue;
    }
    const routed = draftById.get(candidate.next.match(sample.request)?.intentId ?? -1);
    if ((comparison.verdict === 'worse' || comparison.verdict === 'needs_context') && routed)
      errors.push(`Sample ${sample.sampleId} is judged ${comparison.verdict} but routes to ${routed.canonical_name}`);
    if ((comparison.verdict === 'better' || comparison.verdict === 'equivalent') && !routed)
      warnings.push(`Sample ${sample.sampleId} is judged ${comparison.verdict} but no drafted rule matches it`);
    const tools = routed ? (toolsByDraft.get(routed.canonical_name) ?? []) : [];
    const missing = routed ? comparison.expectedTools.filter((tool) => !tools.includes(tool)) : [];
    if (missing.length) warnings.push(`Sample ${sample.sampleId}: drafted workflow lacks ${missing.join(', ')}`);
  }
  return { errors, warnings };
}

function sourceDigestOf(operations: ProposalOperation[], registry: RegistrySnapshot): string {
  const names = new Set(operations.flatMap((op) => op.sourceNames));
  return registryFingerprint(registry.rules.filter((rule) => names.has(rule.canonical_name)));
}

export function validateProposal(
  proposal: { operations: ProposalOperation[]; comparisons?: readonly Comparison[] },
  registry: RegistrySnapshot,
  samples: readonly ValidationSample[] = [],
): ProposalValidation {
  const operations = proposal.operations;
  const base = {
    baseFingerprint: registry.fingerprint,
    sourceDigest: sourceDigestOf(operations, registry),
    affected: [...new Set(operations.flatMap((op) => op.sourceNames))],
  };
  const errors = [
    ...checkShape(operations),
    ...checkSources(operations, registry),
    ...checkDraftNames(operations, registry),
  ];
  const toolsByDraft = new Map<string, string[]>();
  for (const draft of operations.flatMap((op) => op.intents)) {
    const checked = checkDraft(draft);
    errors.push(...checked.errors);
    if (checked.workflow) toolsByDraft.set(draft.canonical_name, workflowTools(checked.workflow));
  }
  if (errors.length) return { ok: false, errors, warnings: [], targetFingerprint: '', insert: [], ...base };
  const candidate = buildCandidate(operations, registry);
  errors.push(...checkRouting(candidate, registry));
  const compared = checkComparisons(candidate, proposal.comparisons ?? [], samples, toolsByDraft);
  errors.push(...compared.errors);
  if (errors.length)
    return { ok: false, errors, warnings: compared.warnings, targetFingerprint: '', insert: [], ...base };
  const insert = candidate.drafts.map((draft) => ({
    canonical_name: draft.canonical_name,
    pattern: draft.pattern,
    workflow: draft.workflow,
    phrases: draft.phrases,
    trigger_words: draft.trigger_words,
    source_message: draft.source_message,
    format: draft.format,
  }));
  return {
    ok: true,
    errors: [],
    warnings: compared.warnings,
    targetFingerprint: registryFingerprint([...candidate.unaffected, ...insert]),
    insert,
    ...base,
  };
}
