import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import { seedIntents } from '../../services/intent/seed-catalog.ts';
import {
  type CanonicalSeed,
  installedSeedFingerprint,
  seedFingerprint,
} from '../../services/intent/seed-replacement.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import type { CreateIntentData, Intent, IntentStatus } from '../types.ts';

const StringArrayCodec = jsonCodec(z.array(z.string()));

export class IntentRepository {
  constructor(
    private db: Database,
    private readonly canonicalSeed: readonly CanonicalSeed[] = seedIntents,
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
      return managed === seedFingerprint(this.canonicalSeed) && managed === seedFingerprint(actual) ? rows : [];
    } catch {
      return [];
    }
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
