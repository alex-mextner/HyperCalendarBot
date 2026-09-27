// Integrity of the managed intent registry. A managed database is intact only when the raw
// approved rows (R), the installed manifest (M), the active revision's target (A) and the rule set
// stored on that revision (B) all carry the same fingerprint. The build's source seed plays no part:
// a new deploy never changes what is active. Imported by migration 065, so it must not load the
// matcher (only zod, the fingerprint leaf and the repository).
import type { Database } from 'bun:sqlite';
import {
  IntentRevisionRepository,
  type IntentRevisionRow,
} from '../../database/repositories/intent-revision.repository.ts';
import { dbLogger } from '../../utils/logger.ts';
import { type RevisionBody, revisionBodyHash } from './revision-body.ts';
import { type RuleDefinition, RuleListCodec, ruleFromRow, seedFingerprint } from './rule-fingerprint.ts';

export interface StoredRule extends RuleDefinition {
  id: number;
}

export type RegistryIntegrity =
  | { state: 'unmanaged' }
  | { state: 'tampered' }
  | { state: 'unledgered' }
  | { state: 'intact'; fingerprint: string; active: IntentRevisionRow; rules: StoredRule[] };

/** Approved rows as rules, or null when any stored column does not decode. */
export function readApprovedRules(revisions: IntentRevisionRepository): StoredRule[] | null {
  const rules: StoredRule[] = [];
  for (const row of revisions.approvedRuleRows()) {
    const rule = ruleFromRow(row);
    if (!rule) return null;
    rules.push({ id: row.id, ...rule });
  }
  return rules;
}

export function registryIntegrity(revisions: IntentRevisionRepository): RegistryIntegrity {
  const manifest = revisions.manifestFingerprint();
  if (manifest === null) return { state: 'unmanaged' };
  const rules = readApprovedRules(revisions);
  if (!rules || seedFingerprint(rules) !== manifest) return { state: 'tampered' };
  const active = revisions.active();
  if (!active || active.target_fingerprint !== manifest) return { state: 'unledgered' };
  const stored = RuleListCodec.safeParse(active.target_rules ?? '');
  if (!stored.success || seedFingerprint(stored.data) !== manifest) return { state: 'unledgered' };
  return { state: 'intact', fingerprint: manifest, active, rules };
}

interface ActiveBaseline {
  definitions: RuleDefinition[];
  fingerprint: string;
  summary: string;
  author: string;
  decidedBy: string;
  previous: IntentRevisionRow | null;
}

function insertActiveBaseline(revisions: IntentRevisionRepository, baseline: ActiveBaseline): void {
  const body: RevisionBody = { type: 'replace_all', summary: baseline.summary, rules: baseline.definitions };
  const now = Date.now();
  revisions.insert({
    kind: 'source_baseline',
    status: 'active',
    parent_id: null,
    base_revision_id: baseline.previous?.id ?? null,
    base_fingerprint: baseline.previous?.target_fingerprint ?? null,
    target_fingerprint: baseline.fingerprint,
    target_rules: JSON.stringify(baseline.definitions),
    body_hash: revisionBodyHash(body),
    body: JSON.stringify(body),
    validation: JSON.stringify({ ok: true, removed: [], inserted: [] }),
    author: baseline.author,
    created_at: now,
    decided_by: baseline.decidedBy,
    decided_at: now,
  });
}

/**
 * Migration 065: ledger the manifest-managed registry that is already installed. Refuses (inserts
 * nothing, never throws) when the raw rows no longer match the manifest, so a tampered registry is
 * never blessed as the active revision.
 */
export function backfillActiveRevision(db: Database): 'backfilled' | 'skipped' | 'refused' {
  const revisions = new IntentRevisionRepository(db);
  const manifest = revisions.manifestFingerprint();
  if (manifest === null || revisions.active()) return 'skipped';
  const rules = readApprovedRules(revisions);
  if (!rules || seedFingerprint(rules) !== manifest) {
    dbLogger.error('intent_registry_tampered: approved rows differ from the manifest; no revision backfilled');
    return 'refused';
  }
  insertActiveBaseline(revisions, {
    definitions: RuleListCodec.parse(JSON.stringify(rules.map(definitionOf))),
    fingerprint: manifest,
    summary: 'Installed catalogue at ledger creation',
    author: 'migration',
    decidedBy: 'migration',
    previous: null,
  });
  return 'backfilled';
}

/**
 * The operator replacement (scripts/replace-intent-basis.ts) installs a whole source seed with a
 * verified backup; it moves the manifest and records the result as the active revision.
 */
export function recordOperatorBaseline(db: Database, seed: readonly RuleDefinitionInput[], fingerprint: string): void {
  const revisions = new IntentRevisionRepository(db);
  const definitions = RuleListCodec.parse(JSON.stringify(seed.map(definitionOf)));
  if (seedFingerprint(definitions) !== fingerprint) throw new Error('Operator baseline does not match its plan');
  revisions.writeManifest(fingerprint, definitions.length);
  const previous = revisions.active();
  if (previous) revisions.setStatus(previous.id, 'superseded');
  insertActiveBaseline(revisions, {
    definitions,
    fingerprint,
    summary: 'Operator seed replacement',
    author: 'operator',
    decidedBy: 'operator_cli',
    previous,
  });
}

interface RuleDefinitionInput {
  canonical_name: string;
  pattern: string;
  workflow: unknown;
  phrases: readonly string[];
  trigger_words: readonly string[];
  source_message: string;
}

/** Only the fingerprinted fields; ids, format and status never enter a revision body. */
const definitionOf = (rule: RuleDefinitionInput) => ({
  canonical_name: rule.canonical_name,
  pattern: rule.pattern,
  workflow: rule.workflow,
  phrases: rule.phrases,
  trigger_words: rule.trigger_words,
  source_message: rule.source_message,
});
