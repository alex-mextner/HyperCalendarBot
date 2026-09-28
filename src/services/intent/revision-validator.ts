// Native validation of a revision body against the live registry. Nothing an author claims is
// trusted: cardinality, names, whole-message patterns, typed workflows and routing through the real
// matcher are re-checked, and every example a removed or replaced rule loses needs an explicit,
// checked disposition. There is no bypass flag.
import type { RevisionKind } from '../../database/repositories/intent-revision.repository.ts';
import type { Intent } from '../../database/types.ts';
import { IntentMatcher } from './intent-matcher.ts';
import { normalize } from './normalizer.ts';
import type { DroppedRules, ExampleDisposition, RevisionBody, RevisionOperation } from './revision-body.ts';
import type { StoredRule } from './revision-ledger.ts';
import { digestsByName, type RuleDefinition, seedFingerprint } from './rule-fingerprint.ts';
import { canonicalMetadata } from './seed-catalog.ts';
import { type CanonicalSeed, validateCanonicalSeed } from './seed-replacement.ts';
import { readWorkflowVersion } from './workflow-input.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateWorkflow } from './workflow-validator.ts';

export interface RegistryView {
  rules: StoredRule[];
  reservedNames: string[];
  /**
   * Which kind of revision last changed each active rule's definition, comparing each activation's
   * rule digests with the activation before it; carrying a rule over unchanged does not claim it.
   * Null when that history does not verify.
   */
  provenance: Map<string, RevisionKind> | null;
}

export type RevisionOutcome =
  | { ok: false; errors: string[] }
  | {
      ok: true;
      targetRules: RuleDefinition[];
      targetFingerprint: string;
      removed: string[];
      inserted: string[];
      dropped?: DroppedRules;
    };

const MAX_OPERATION_RULES = 32;
const DRAFT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/;
const CATASTROPHIC_BACKTRACKING = 'a group or backreference repeated without bound can backtrack catastrophically';
/** A group may repeat at most this often; `{1,2}` in the source catalogue is well inside. */
const MAX_GROUP_REPEAT = 3;
const BRACES = /^\{(\d+)?(,)?(\d+)?\}/;

/** `+`, `*`, `{n,}` or a `{n,m}` whose upper bound exceeds MAX_GROUP_REPEAT, at `index`. */
function unboundedAt(pattern: string, index: number): boolean {
  const char = pattern[index];
  if (char === '+' || char === '*') return true;
  const braces = char === '{' ? BRACES.exec(pattern.slice(index)) : null;
  if (!braces) return false;
  const upper = braces[2] ? braces[3] : braces[1];
  return upper === undefined || Number(upper) > MAX_GROUP_REPEAT;
}
/** A numbered (`\1`) or named (`\k<name>`) backreference. */
const BACKREFERENCE = /^\\(?:[1-9]\d*|k<[^>]+>)/;

/**
 * True when a group or a backreference is repeated without bound or more than MAX_GROUP_REPEAT
 * times. That single shape covers the group-level catastrophic-backtracking families: nested
 * repetition (`(a+)+`, `(?:(?:x)+ y)*`), ambiguous alternation (`(?:a|aa)+`, `(?:a|aa){1,8000}`)
 * and repeated backreferences (`(a+)\1*`, `(?<x>a)\k<x>*`). Groups repeated at most
 * MAX_GROUP_REPEAT times, such as `(?:/x+){1,2}`, are allowed; no rule in the source catalogue
 * repeats a group more. Character-level repetition is not judged here.
 */
function hasUnboundedGroupRepetition(pattern: string): boolean {
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '\\') {
      const backreference = BACKREFERENCE.exec(pattern.slice(index));
      if (backreference && unboundedAt(pattern, index + backreference[0].length)) return true;
      index++;
    } else if (char === '[') index = classEnd(pattern, index);
    else if (char === ')' && unboundedAt(pattern, index + 1)) return true;
  }
  return false;
}

function classEnd(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index++) {
    if (pattern[index] === '\\') index++;
    else if (pattern[index] === ']') return index;
  }
  return pattern.length;
}
/** Drafts get negative matcher ids, which no SQLite rowid (always >= 1) can collide with. */
const draftId = (index: number) => -(index + 1);

const CARDINALITY: { [kind in RevisionOperation['kind']]: (sources: number, intents: number) => boolean } = {
  create: (sources, intents) => sources === 0 && intents >= 1,
  generalize: (sources, intents) => sources === 1 && intents === 1,
  consolidate: (sources, intents) => sources >= 2 && intents === 1,
  retire: (sources, intents) => sources >= 1 && intents === 0,
};

const definitionOf = (rule: StoredRule): RuleDefinition => ({
  canonical_name: rule.canonical_name,
  pattern: rule.pattern,
  workflow: rule.workflow,
  phrases: rule.phrases,
  trigger_words: rule.trigger_words,
  source_message: rule.source_message,
});

/** Names whose definition disappears or changes (removed) and whose definition is new (inserted). */
function diffRuleSets(current: readonly RuleDefinition[], target: readonly RuleDefinition[]) {
  const before = digestsByName(current);
  const after = digestsByName(target);
  const removed = [...before].filter(([name, hash]) => after.get(name) !== hash).map(([name]) => name);
  const inserted = [...after].filter(([name, hash]) => before.get(name) !== hash).map(([name]) => name);
  return { removed: removed.sort(), inserted: inserted.sort() };
}

/**
 * Every active definition the target drops (the `removed` names: gone, or replaced under the same
 * name), under the kind of revision that last changed it; a source catalogue that reverts a manual
 * edit lists it.
 */
function droppedBy(removed: readonly string[], provenance: Map<string, RevisionKind>): DroppedRules {
  const dropped: DroppedRules = { learned: [], manual: [], source_baseline: [] };
  for (const name of removed) dropped[provenance.get(name) ?? 'source_baseline'].push(name);
  return dropped;
}

/** With `provenance`, the outcome also lists what it drops by origin (whole-catalogue revisions). */
function success(
  current: readonly RuleDefinition[],
  targetRules: RuleDefinition[],
  provenance?: Map<string, RevisionKind>,
) {
  const diff = diffRuleSets(current, targetRules);
  return {
    ok: true as const,
    targetRules,
    targetFingerprint: seedFingerprint(targetRules),
    ...diff,
    ...(provenance === undefined ? {} : { dropped: droppedBy(diff.removed, provenance) }),
  };
}

function checkShape(operations: readonly RevisionOperation[]): string[] {
  const errors: string[] = [];
  const rules = operations.reduce((sum, op) => sum + op.intents.length, 0);
  if (rules > MAX_OPERATION_RULES) errors.push(`A revision may carry at most ${MAX_OPERATION_RULES} rules`);
  operations.forEach((op, index) => {
    if (!CARDINALITY[op.kind](op.sourceNames.length, op.intents.length))
      errors.push(
        `Operation ${index} (${op.kind}) has ${op.sourceNames.length} sources and ${op.intents.length} intents`,
      );
    if (op.kind === 'create' && op.dispositions.length) errors.push(`Operation ${index} (create) removes no examples`);
  });
  return errors;
}

function checkSources(operations: readonly RevisionOperation[], registry: RegistryView): string[] {
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

function checkDraftNames(operations: readonly RevisionOperation[], registry: RegistryView): string[] {
  const errors: string[] = [];
  const affected = new Set(operations.flatMap((op) => op.sourceNames));
  const taken = new Set([
    ...registry.rules.map((rule) => rule.canonical_name).filter((name) => !affected.has(name)),
    ...registry.reservedNames,
  ]);
  const drafted = new Set<string>();
  for (const op of operations)
    for (const { canonical_name: name } of op.intents) {
      if (!DRAFT_NAME.test(name) || name.length > 128) errors.push(`${name}: names are lowercase dotted snake_case`);
      if (taken.has(name)) errors.push(`${name}: name is held by another intent`);
      if (drafted.has(name)) errors.push(`${name}: name is drafted twice`);
      if (name.startsWith('basis.') && !(op.kind !== 'create' && op.sourceNames.includes(name)))
        errors.push(`${name}: only the operation replacing a basis rule may keep its basis name`);
      drafted.add(name);
    }
  return errors;
}

function checkPattern(name: string, pattern: string): string[] {
  const errors: string[] = [];
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$') || pattern.length > 8192)
    errors.push(`${name}: pattern must be a finite matcher anchored to the whole message (^...$)`);
  if (hasUnboundedGroupRepetition(pattern)) errors.push(`${name}: ${CATASTROPHIC_BACKTRACKING}`);
  try {
    new RegExp(pattern, 'di');
  } catch {
    // The compile failure itself is the finding; its message adds nothing for the reviewer.
    errors.push(`${name}: pattern does not compile`);
  }
  return errors;
}

function checkDraft(draft: RuleDefinition): string[] {
  const name = draft.canonical_name;
  const errors = checkPattern(name, draft.pattern);
  if (readWorkflowVersion(draft.workflow) !== 2) errors.push(`${name}: explicit workflow version 2 is required`);
  const parsed = WorkflowSchema.safeParse(draft.workflow);
  if (!parsed.success) return [...errors, `${name}: workflow does not match the schema`];
  if (errors.length === 0) errors.push(...validateWorkflow(parsed.data, draft.pattern).map((e) => `${name}: ${e}`));
  if (!draft.phrases.length || !draft.trigger_words.length) errors.push(`${name}: examples and triggers are required`);
  if (draft.phrases.some((phrase) => !normalize(phrase))) errors.push(`${name}: empty phrase after normalization`);
  if (draft.trigger_words.some((word) => !normalize(word))) errors.push(`${name}: empty trigger word`);
  return errors;
}

function asIntent(rule: RuleDefinition, id: number): Intent {
  return {
    id,
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

interface Candidate {
  /** Target set with matcher ids: unaffected rules keep their row id, drafts get synthetic ids. */
  target: { id: number; rule: RuleDefinition; op?: RevisionOperation }[];
  baseline: IntentMatcher;
  next: IntentMatcher;
}

function buildCandidate(operations: readonly RevisionOperation[], registry: RegistryView): Candidate {
  const affected = new Set(operations.flatMap((op) => op.sourceNames));
  const unaffected = registry.rules
    .filter((rule) => !affected.has(rule.canonical_name))
    .map((rule) => ({ id: rule.id, rule: definitionOf(rule) }));
  const drafts = operations.flatMap((op) => op.intents.map((rule) => ({ rule, op })));
  const target = [...unaffected, ...drafts.map((draft, index) => ({ id: draftId(index), ...draft }))];
  const baseline = new IntentMatcher();
  baseline.load(registry.rules.map((rule) => asIntent(rule, rule.id)));
  const next = new IntentMatcher();
  next.load(target.map((entry) => asIntent(entry.rule, entry.id)));
  return { target, baseline, next };
}

const examplesOf = (rule: RuleDefinition) => [...new Set([...rule.phrases, rule.source_message].filter(Boolean))];

function checkRouting(candidate: Candidate): string[] {
  const errors: string[] = [];
  for (const { id, rule, op } of candidate.target)
    for (const example of examplesOf(rule)) {
      const routed = candidate.next.match(example)?.intentId;
      if (op && routed !== id)
        errors.push(`${rule.canonical_name}: example "${example}" does not route uniquely to it`);
      if (!op && candidate.baseline.match(example)?.intentId === id && routed !== id)
        errors.push(`Active ${rule.canonical_name} loses its example "${example}"`);
    }
  const draftIds = new Set(candidate.target.filter((entry) => entry.op).map((entry) => entry.id));
  for (const meta of canonicalMetadata)
    for (const negative of meta.negativeExamples) {
      const routed = candidate.next.match(negative)?.intentId;
      if (routed !== undefined && draftIds.has(routed))
        errors.push(`Known negative "${negative}" of ${meta.name} now routes to a drafted rule`);
    }
  return errors;
}

function checkDisposition(disposition: ExampleDisposition, routedTo: string | undefined): string | null {
  const { example } = disposition;
  if (disposition.disposition === 'covered_by') {
    if (!disposition.coveredBy) return `Disposition for "${example}" names no covering rule`;
    if (routedTo !== disposition.coveredBy)
      return `"${example}" routes to ${routedTo ?? 'no rule'}, not to ${disposition.coveredBy}`;
    return null;
  }
  if (routedTo !== undefined) return `"${example}" is marked ${disposition.disposition} but routes to ${routedTo}`;
  return null;
}

/** Every example a removed or replaced rule loses is either covered by the operation or disposed of. */
function checkPreservation(candidate: Candidate, op: RevisionOperation, registry: RegistryView): string[] {
  const errors: string[] = [];
  const names = new Map(candidate.target.map((entry) => [entry.id, entry.rule.canonical_name]));
  const ownIds = new Set(candidate.target.filter((entry) => entry.op === op).map((entry) => entry.id));
  const lost = new Set<string>();
  for (const source of registry.rules.filter((rule) => op.sourceNames.includes(rule.canonical_name)))
    for (const example of examplesOf(source)) {
      const routed = candidate.next.match(example)?.intentId;
      if (candidate.baseline.match(example)?.intentId === source.id && (routed === undefined || !ownIds.has(routed)))
        lost.add(example);
    }
  for (const example of lost) {
    const given = op.dispositions.filter((disposition) => disposition.example === example);
    if (given.length !== 1)
      errors.push(`${op.kind} of ${op.sourceNames.join(', ')}: example "${example}" needs exactly one disposition`);
  }
  for (const disposition of op.dispositions) {
    if (!lost.has(disposition.example)) errors.push(`Disposition for "${disposition.example}" matches no lost example`);
    const routed = candidate.next.match(disposition.example)?.intentId;
    const problem = checkDisposition(disposition, routed === undefined ? undefined : names.get(routed));
    if (problem) errors.push(problem);
  }
  return errors;
}

function validateOperations(operations: readonly RevisionOperation[], registry: RegistryView): RevisionOutcome {
  const errors = [
    ...checkShape(operations),
    ...checkSources(operations, registry),
    ...checkDraftNames(operations, registry),
    ...operations.flatMap((op) => op.intents.flatMap(checkDraft)),
  ];
  if (errors.length) return { ok: false, errors };
  const candidate = buildCandidate(operations, registry);
  errors.push(...checkRouting(candidate));
  for (const op of operations) errors.push(...checkPreservation(candidate, op, registry));
  if (errors.length) return { ok: false, errors };
  return success(
    registry.rules.map(definitionOf),
    candidate.target.map((entry) => entry.rule),
  );
}

/** A whole source catalogue replaces the active set; it lists every rule it would drop. */
function validateReplaceAll(rules: RuleDefinition[], registry: RegistryView): RevisionOutcome {
  const seed: CanonicalSeed[] = [];
  for (const rule of rules) {
    const { workflow } = rule;
    if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow))
      return { ok: false, errors: [`${rule.canonical_name}: workflow must be an object`] };
    seed.push({ ...rule, workflow });
  }
  const risky = rules.filter((rule) => hasUnboundedGroupRepetition(rule.pattern));
  if (risky.length)
    return { ok: false, errors: risky.map((rule) => `${rule.canonical_name}: ${CATASTROPHIC_BACKTRACKING}`) };
  const reserved = new Set(registry.reservedNames);
  const taken = rules.filter((rule) => reserved.has(rule.canonical_name)).map((rule) => rule.canonical_name);
  if (taken.length) return { ok: false, errors: taken.map((name) => `${name}: name is held by another intent`) };
  try {
    validateCanonicalSeed(seed);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  // Without a verified history the draft could not say whose rules it drops.
  if (registry.provenance === null)
    return { ok: false, errors: ['Revision history does not verify; the origin of dropped rules is unknown'] };
  return success(registry.rules.map(definitionOf), rules, registry.provenance);
}

export function validateRevision(body: RevisionBody, registry: RegistryView): RevisionOutcome {
  return body.type === 'operations'
    ? validateOperations(body.operations, registry)
    : validateReplaceAll(body.rules, registry);
}
