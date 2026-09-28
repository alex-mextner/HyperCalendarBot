import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import { registryIntegrity } from '../../services/intent/revision-ledger.ts';
import { ruleFingerprint } from '../../services/intent/rule-fingerprint.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { dbLogger } from '../../utils/logger.ts';
import type { CreateIntentData, Intent, IntentStatus } from '../types.ts';
import { IntentRevisionRepository } from './intent-revision.repository.ts';

const StringArrayCodec = jsonCodec(z.array(z.string()));

export class IntentRepository {
  constructor(private db: Database) {}

  isManagedBasis(): boolean {
    return new IntentRevisionRepository(this.db).manifest() !== null;
  }

  private requireUnmanaged(): void {
    if (this.isManagedBasis())
      throw new Error('INTENT_BASIS_READ_ONLY: propose a revision and have an administrator approve it');
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

  /**
   * Identity of an approved rule that may still run: null when the row is gone or no longer
   * approved, a column does not decode, or the managed registry fails its integrity check.
   */
  currentRuleFingerprint(id: number): string | null {
    return this.db.transaction(() => {
      const row = this.getById(id);
      return row ? this.runnableFingerprint(row) : null;
    })();
  }

  /** The same identity for a row already read, so a run and its identity come from one read. */
  runnableFingerprint(row: Intent): string | null {
    if (row.status !== 'approved') return null;
    return this.registryState() === 'usable' ? ruleFingerprint(row) : null;
  }

  /**
   * Approved rows. A managed registry loads only while its rows, manifest and active revision
   * agree; the build's source seed is never consulted, so a source-only deploy keeps the active
   * catalogue. Any disagreement disables the whole catalogue (fail closed) and is logged.
   */
  getApproved(): Intent[] {
    return this.db.transaction(() => {
      const rows = this.db.query<Intent, [string]>('SELECT * FROM intents WHERE status = ?').all('approved');
      const state = this.registryState();
      if (state === 'usable') return rows;
      dbLogger.error({ state }, `intent_registry_${state}: managed intent catalogue disabled`);
      return [];
    })();
  }

  /** The one fail-closed gate: an unmanaged or intact registry may serve its rules. */
  private registryState(): 'usable' | 'tampered' | 'unledgered' {
    const { state } = registryIntegrity(new IntentRevisionRepository(this.db));
    return state === 'unmanaged' || state === 'intact' ? 'usable' : state;
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
