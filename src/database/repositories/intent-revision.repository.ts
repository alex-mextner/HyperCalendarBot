// Storage of the managed intent registry: the append-only revision ledger (`intent_revisions`),
// the installed manifest and the approved rows it vouches for. Integrity decisions live in
// `services/intent/revision-ledger.ts`; this file only reads and writes rows.
import type { Database } from 'bun:sqlite';
import type { RuleDefinition, StoredRuleRow } from '../../services/intent/rule-fingerprint.ts';

export type RevisionKind = 'source_baseline' | 'manual' | 'learned';
export type RevisionStatus = 'draft' | 'validated' | 'active' | 'superseded' | 'rejected';

export interface IntentRevisionRow {
  id: number;
  kind: RevisionKind;
  status: RevisionStatus;
  parent_id: number | null;
  base_revision_id: number | null;
  base_fingerprint: string | null;
  target_fingerprint: string | null;
  target_rules: string | null;
  body_hash: string;
  body: string;
  validation: string;
  author: string;
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_reason: string | null;
}

export type NewRevision = Omit<IntentRevisionRow, 'id' | 'decided_by' | 'decided_at' | 'decision_reason'> &
  Partial<Pick<IntentRevisionRow, 'decided_by' | 'decided_at'>>;

export interface RevisionDecision {
  by: string;
  at: number;
  reason?: string;
}

const COLUMNS =
  'kind, status, parent_id, base_revision_id, base_fingerprint, target_fingerprint, target_rules, body_hash, body, validation, author, created_at, decided_by, decided_at';

export class IntentRevisionRepository {
  constructor(private readonly db: Database) {}

  insert(row: NewRevision): number {
    const result = this.db
      .prepare(`INSERT INTO intent_revisions (${COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.kind,
        row.status,
        row.parent_id,
        row.base_revision_id,
        row.base_fingerprint,
        row.target_fingerprint,
        row.target_rules,
        row.body_hash,
        row.body,
        row.validation,
        row.author,
        row.created_at,
        row.decided_by ?? null,
        row.decided_at ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  get(id: number): IntentRevisionRow | null {
    return this.db.query<IntentRevisionRow, [number]>('SELECT * FROM intent_revisions WHERE id = ?').get(id);
  }

  list(status?: RevisionStatus): IntentRevisionRow[] {
    if (status === undefined)
      return this.db.query<IntentRevisionRow, []>('SELECT * FROM intent_revisions ORDER BY id').all();
    return this.db
      .query<IntentRevisionRow, [string]>('SELECT * FROM intent_revisions WHERE status = ? ORDER BY id')
      .all(status);
  }

  active(): IntentRevisionRow | null {
    return this.db.query<IntentRevisionRow, []>("SELECT * FROM intent_revisions WHERE status = 'active'").get();
  }

  /** Revisions that were once activated, oldest first. */
  decidedActivations(): IntentRevisionRow[] {
    return this.db
      .query<IntentRevisionRow, []>(
        "SELECT * FROM intent_revisions WHERE decided_at IS NOT NULL AND status IN ('active','superseded') ORDER BY id",
      )
      .all();
  }

  findSourceBaseline(bodyHash: string, baseRevisionId: number): IntentRevisionRow | null {
    return this.db
      .query<IntentRevisionRow, [string, number]>(
        "SELECT * FROM intent_revisions WHERE kind = 'source_baseline' AND body_hash = ? AND base_revision_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(bodyHash, baseRevisionId);
  }

  setStatus(id: number, status: RevisionStatus, decision?: RevisionDecision): void {
    this.db
      .prepare(
        'UPDATE intent_revisions SET status = ?, decided_by = COALESCE(?, decided_by), decided_at = COALESCE(?, decided_at), decision_reason = COALESCE(?, decision_reason) WHERE id = ?',
      )
      .run(status, decision?.by ?? null, decision?.at ?? null, decision?.reason ?? null, id);
  }

  manifestFingerprint(): string | null {
    const table = this.db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intent_basis_manifest'")
      .get();
    if (!table) return null;
    return (
      this.db
        .query<{ fingerprint: string }, []>('SELECT fingerprint FROM intent_basis_manifest WHERE singleton = 1')
        .get()?.fingerprint ?? null
    );
  }

  writeManifest(fingerprint: string, ruleCount: number): void {
    this.db.run(
      "INSERT INTO intent_basis_manifest VALUES(1,?,datetime('now'),?) ON CONFLICT(singleton) DO UPDATE SET fingerprint=excluded.fingerprint,installed_at=excluded.installed_at,rule_count=excluded.rule_count",
      [fingerprint, ruleCount],
    );
  }

  approvedRuleRows(): StoredRuleRow[] {
    return this.db
      .query<StoredRuleRow, []>(
        "SELECT id, canonical_name, pattern, workflow, phrases, trigger_words, source_message FROM intents WHERE status = 'approved' ORDER BY id",
      )
      .all();
  }

  /** Names held by rows that are not approved; no revision may take them over. */
  reservedNames(): string[] {
    return this.db
      .query<{ canonical_name: string }, []>("SELECT canonical_name FROM intents WHERE status != 'approved'")
      .all()
      .map((row) => row.canonical_name);
  }

  deleteIntents(ids: readonly number[]): void {
    const remove = this.db.prepare('DELETE FROM intents WHERE id = ?');
    for (const id of ids) remove.run(id);
  }

  insertApprovedIntent(rule: RuleDefinition): void {
    this.db.run(
      "INSERT INTO intents(canonical_name,pattern,workflow,phrases,trigger_words,source_message,format,status) VALUES(?,?,?,?,?,?,'text','approved')",
      [
        rule.canonical_name,
        rule.pattern,
        JSON.stringify(rule.workflow),
        JSON.stringify(rule.phrases),
        JSON.stringify(rule.trigger_words),
        rule.source_message,
      ],
    );
  }
}
