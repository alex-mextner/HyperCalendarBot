import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import { seedIntents } from '../../services/intent/seed-catalog.ts';
import {
  type CanonicalSeed,
  installedSeedFingerprint,
  seedFingerprint,
} from '../../services/intent/seed-replacement.ts';
import { type RevisionLedgerCheck, sidecarLedgerCheck } from '../../services/intent-learning/ledger.ts';
import { readRegistry } from '../../services/intent-learning/registry.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import type { CreateIntentData, Intent, IntentStatus } from '../types.ts';

const StringArrayCodec = jsonCodec(z.array(z.string()));
const SessionIntentCodec = jsonCodec(z.object({ intentId: z.number() }));

/** One admin-approved change of the active registry, applied as a single compare-and-swap. */
export interface RegistryRevisionPlan {
  baseFingerprint: string;
  targetFingerprint: string;
  removeNames: string[];
  insert: {
    canonical_name: string;
    pattern: string;
    workflow: CanonicalSeed['workflow'];
    phrases: string[];
    trigger_words: string[];
    source_message: string;
    format: string;
  }[];
  /** Workflow sessions created at or after this time protect the intents they reference. */
  protectSessionsSince: number;
}

export type RegistryRevisionFailure =
  | 'base_mismatch'
  | 'missing_source'
  | 'reserved_name'
  | 'session_active'
  | 'target_mismatch';

export class RegistryRevisionError extends Error {
  constructor(
    readonly code: RegistryRevisionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryRevisionError';
  }
}

export class IntentRepository {
  constructor(
    private db: Database,
    private readonly canonicalSeed: readonly CanonicalSeed[] = seedIntents,
    private readonly revisionLedger: RevisionLedgerCheck = sidecarLedgerCheck(db.filename),
  ) {}

  isManagedBasis(): boolean {
    return installedSeedFingerprint(this.db) !== null;
  }

  private requireUnmanaged(): void {
    if (this.isManagedBasis())
      throw new Error('INTENT_BASIS_READ_ONLY: edit the versioned source and apply its reviewed migration');
  }

  create(data: CreateIntentData): number {
    this.requireUnmanaged();
    const result = this.db
      .prepare(`
      INSERT INTO intents (canonical_name, phrases, trigger_words, pattern, workflow, format, source_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        data.canonical_name,
        JSON.stringify(data.phrases),
        JSON.stringify(data.trigger_words ?? []),
        data.pattern ?? null,
        JSON.stringify(data.workflow),
        data.format,
        data.source_message ?? null,
      );

    return Number(result.lastInsertRowid);
  }

  getById(id: number): Intent | null {
    return this.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Intent | null;
  }

  getApproved(): Intent[] {
    const rows = this.db.prepare('SELECT * FROM intents WHERE status = ?').all('approved') as Intent[];
    const managed = installedSeedFingerprint(this.db);
    if (managed === null) return rows;
    try {
      const actual = rows.map((row) => ({
        canonical_name: row.canonical_name,
        pattern: row.pattern ?? '',
        workflow: JSON.parse(row.workflow),
        phrases: JSON.parse(row.phrases),
        trigger_words: JSON.parse(row.trigger_words ?? '[]'),
        source_message: row.source_message ?? '',
      }));
      if (managed !== seedFingerprint(actual)) return [];
      return managed === seedFingerprint(this.canonicalSeed) || this.revisionLedger(managed) ? rows : [];
    } catch {
      return [];
    }
  }

  /**
   * Applies an approved revision atomically: the approved rows must still fingerprint to the
   * base (and the manifest must agree), the result must fingerprint to the target, and the
   * manifest moves to the target in the same immediate transaction. Any failure rolls back all.
   */
  applyRegistryRevision(plan: RegistryRevisionPlan): { removedIds: number[]; insertedIds: number[] } {
    return this.db
      .transaction(() => {
        const before = readRegistry(this.db, this.canonicalSeed);
        if (
          before.fingerprint !== plan.baseFingerprint ||
          (before.managed && before.manifestFingerprint !== plan.baseFingerprint)
        )
          throw new RegistryRevisionError('base_mismatch', 'Active intents changed after the proposal was validated');
        const removedIds = plan.removeNames.map((name) => {
          const rule = before.rules.find((candidate) => candidate.canonical_name === name);
          if (!rule) throw new RegistryRevisionError('missing_source', `Active intent ${name} no longer exists`);
          return rule.id;
        });
        const reserved = new Set(before.reservedNames);
        const clash = plan.insert.find((item) => reserved.has(item.canonical_name));
        if (clash) throw new RegistryRevisionError('reserved_name', `${clash.canonical_name} is held by a draft row`);
        this.assertNoActiveSessions(new Set(removedIds), plan.protectSessionsSince);
        const insertedIds = this.replaceRows(removedIds, plan.insert);
        const after = readRegistry(this.db, this.canonicalSeed);
        if (after.fingerprint !== plan.targetFingerprint)
          throw new RegistryRevisionError('target_mismatch', 'Applied registry does not match the approved target');
        if (before.managed)
          this.db.run(
            "UPDATE intent_basis_manifest SET fingerprint = ?, installed_at = datetime('now'), rule_count = ? WHERE singleton = 1",
            [plan.targetFingerprint, after.rules.length],
          );
        return { removedIds, insertedIds };
      })
      .immediate();
  }

  private assertNoActiveSessions(affectedIds: Set<number>, since: number): void {
    if (affectedIds.size === 0) return;
    const hasTable = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow_sessions'")
      .get();
    if (!hasTable) return;
    const sessions = this.db
      .query<{ data: string }, [number]>('SELECT data FROM workflow_sessions WHERE created_at >= ?')
      .all(since);
    for (const session of sessions) {
      const parsed = SessionIntentCodec.safeParse(session.data);
      // An unreadable recent session might reference an affected intent; refuse rather than guess.
      if (!parsed.success || affectedIds.has(parsed.data.intentId))
        throw new RegistryRevisionError('session_active', 'A recent workflow session uses an affected intent');
    }
  }

  private replaceRows(removedIds: number[], insert: RegistryRevisionPlan['insert']): number[] {
    const remove = this.db.prepare('DELETE FROM intents WHERE id = ?');
    for (const id of removedIds) remove.run(id);
    const add = this.db.prepare(
      "INSERT INTO intents(canonical_name, pattern, workflow, phrases, trigger_words, source_message, format, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')",
    );
    return insert.map((item) =>
      Number(
        add.run(
          item.canonical_name,
          item.pattern,
          JSON.stringify(item.workflow),
          JSON.stringify(item.phrases),
          JSON.stringify(item.trigger_words),
          item.source_message,
          item.format,
        ).lastInsertRowid,
      ),
    );
  }

  updateStatus(id: number, status: IntentStatus): void {
    this.requireUnmanaged();
    this.db.prepare('UPDATE intents SET status = ? WHERE id = ?').run(status, id);
  }

  appendPhrases(id: number, newPhrases: string[]): void {
    this.requireUnmanaged();
    const intent = this.getById(id);
    if (!intent) return;

    const existingPhrases = StringArrayCodec.parse(intent.phrases);
    const phraseSet = new Set(existingPhrases);

    for (const phrase of newPhrases) {
      phraseSet.add(phrase);
    }

    const mergedPhrases = Array.from(phraseSet);
    this.db.prepare('UPDATE intents SET phrases = ? WHERE id = ?').run(JSON.stringify(mergedPhrases), id);
  }

  findByCanonicalName(name: string): Intent | null {
    return this.db.prepare('SELECT * FROM intents WHERE canonical_name = ?').get(name) as Intent | null;
  }

  update(
    id: number,
    data: Partial<
      Omit<
        Pick<Intent, 'phrases' | 'trigger_words' | 'pattern' | 'workflow' | 'format'>,
        'phrases' | 'trigger_words' | 'workflow'
      > & {
        phrases?: string | string[];
        trigger_words?: string | string[];
        workflow?: string | object;
      }
    >,
  ): void {
    this.requireUnmanaged();
    const fields: string[] = [];
    const values: SQLQueryBindings[] = [];

    if (data.phrases !== undefined) {
      fields.push('phrases = ?');
      values.push(typeof data.phrases === 'string' ? data.phrases : JSON.stringify(data.phrases));
    }

    if (data.trigger_words !== undefined) {
      fields.push('trigger_words = ?');
      values.push(typeof data.trigger_words === 'string' ? data.trigger_words : JSON.stringify(data.trigger_words));
    }

    if (data.pattern !== undefined) {
      fields.push('pattern = ?');
      values.push(data.pattern);
    }

    if (data.workflow !== undefined) {
      fields.push('workflow = ?');
      values.push(typeof data.workflow === 'string' ? data.workflow : JSON.stringify(data.workflow));
    }

    if (data.format !== undefined) {
      fields.push('format = ?');
      values.push(data.format);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE intents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}
