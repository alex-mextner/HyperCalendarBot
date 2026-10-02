// Read-only view of the active intent registry in the main database, fingerprinted exactly as the
// managed-basis manifest is, so a compare-and-swap can prove nothing changed underneath a proposal.
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Intent } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { seedIntents } from '../intent/seed-catalog.ts';
import {
  type CanonicalSeed,
  installedSeedFingerprint,
  intentRows,
  seedFingerprint,
} from '../intent/seed-replacement.ts';
import { IntentLearningError, type LearningContext } from './context.ts';
import { type JsonObject, JsonObjectSchema } from './schemas.ts';

const WorkflowJson = jsonCodec(JsonObjectSchema);
const StringArrayJson = jsonCodec(z.array(z.string()));

export interface RegistryRule {
  id: number;
  canonical_name: string;
  pattern: string;
  workflow: JsonObject;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  format: string;
}

export interface RegistrySnapshot {
  /** True once a canonical basis manifest is installed in the main database. */
  managed: boolean;
  manifestFingerprint: string | null;
  /** Fingerprint of the approved rows, computed like the manifest. */
  fingerprint: string;
  rules: RegistryRule[];
  /** Names held by non-approved rows; the UNIQUE constraint forbids reusing them. */
  reservedNames: string[];
  /** Fingerprint of the versioned source baseline shipped with this build. */
  sourceFingerprint: string;
}

export class RegistryUnreadableError extends Error {
  constructor(intentId: number) {
    super(`Active intent ${intentId} has malformed stored JSON; the registry cannot be fingerprinted`);
    this.name = 'RegistryUnreadableError';
  }
}

function ruleOf(row: Intent): RegistryRule {
  const workflow = WorkflowJson.safeParse(row.workflow);
  const phrases = StringArrayJson.safeParse(row.phrases);
  const triggers = StringArrayJson.safeParse(row.trigger_words ?? '[]');
  if (!workflow.success || !phrases.success || !triggers.success) throw new RegistryUnreadableError(row.id);
  return {
    id: row.id,
    canonical_name: row.canonical_name,
    pattern: row.pattern ?? '',
    workflow: workflow.data,
    phrases: phrases.data,
    trigger_words: triggers.data,
    source_message: row.source_message ?? '',
    format: row.format,
  };
}

export function canonicalOf(rule: Omit<RegistryRule, 'id' | 'format'>): CanonicalSeed {
  return {
    canonical_name: rule.canonical_name,
    pattern: rule.pattern,
    workflow: rule.workflow,
    phrases: rule.phrases,
    trigger_words: rule.trigger_words,
    source_message: rule.source_message,
  };
}

export function registryFingerprint(rules: readonly Omit<RegistryRule, 'id' | 'format'>[]): string {
  return seedFingerprint(rules.map(canonicalOf));
}

export function readRegistry(db: Database, sourceSeed: readonly CanonicalSeed[] = seedIntents): RegistrySnapshot {
  const rows = intentRows(db);
  const rules = rows.filter((row) => row.status === 'approved').map(ruleOf);
  const manifestFingerprint = installedSeedFingerprint(db);
  return {
    managed: manifestFingerprint !== null,
    manifestFingerprint,
    fingerprint: registryFingerprint(rules),
    rules,
    reservedNames: rows.filter((row) => row.status !== 'approved').map((row) => row.canonical_name),
    sourceFingerprint: seedFingerprint(sourceSeed),
  };
}

/** The registry the matcher would load: unmanaged rows as-is, managed rows only when intact. */
export function registryIsIntact(snapshot: RegistrySnapshot): boolean {
  return !snapshot.managed || snapshot.manifestFingerprint === snapshot.fingerprint;
}

/** The live registry for a learning operation; malformed stored rows make it unavailable, never guessed. */
export function readRegistryOrThrow(ctx: LearningContext): RegistrySnapshot {
  try {
    return readRegistry(ctx.mainDb, ctx.sourceSeed);
  } catch (err) {
    if (err instanceof RegistryUnreadableError) throw new IntentLearningError('registry_unavailable', err.message);
    throw err;
  }
}
