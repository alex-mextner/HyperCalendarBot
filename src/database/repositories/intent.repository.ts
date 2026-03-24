import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { z } from 'zod';
import type { CreateIntentData, Intent, IntentStatus } from '../types.ts';

export class IntentRepository {
  constructor(private db: Database) {}

  create(data: CreateIntentData): number {
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
    return this.db.prepare('SELECT * FROM intents WHERE status = ?').all('approved') as Intent[];
  }

  updateStatus(id: number, status: IntentStatus): void {
    this.db.prepare('UPDATE intents SET status = ? WHERE id = ?').run(status, id);
  }

  appendPhrases(id: number, newPhrases: string[]): void {
    const intent = this.getById(id);
    if (!intent) return;

    const existingPhrases = z.array(z.string()).parse(JSON.parse(intent.phrases));
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
