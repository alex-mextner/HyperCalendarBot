// Drafts, exact administrator approval, integrity refusals and the live-session guard of the
// intent revision ledger, against a real migrated SQLite database and the real matcher.
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import {
  WORKFLOW_SESSION_TTL_MS,
  WorkflowSessionRepository,
} from '../../../src/database/repositories/workflow-session.repository.ts';
import type { RevisionBodyInput, RevisionOperationInput } from '../../../src/services/intent/revision-body.ts';
import {
  type AdminPrincipal,
  adminFromOperatorCli,
  adminFromTelegram,
  IntentRevisionService,
} from '../../../src/services/intent/revision-service.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';
import type { CanonicalSeed } from '../../../src/services/intent/seed-replacement.ts';
import { WorkflowSchema } from '../../../src/services/intent/workflow-schema.ts';
import { installSeed, openTempRegistry, registrySnapshot, type TempRegistry } from '../../helpers/intent-registry.ts';

const HELP_WORKFLOW = { version: 2, steps: [{ call: 'get_bot_info', input: {} }] };
const help: CanonicalSeed = {
  canonical_name: 'basis.help',
  pattern: '^(?:помощь|help)$',
  phrases: ['помощь', 'help'],
  trigger_words: ['помощь', 'help'],
  source_message: 'помощь',
  workflow: HELP_WORKFLOW,
};
const timeNow = seedIntents.find((rule) => rule.canonical_name === 'basis.time.now')!;
const seed = [help, timeNow];
const NOW = 1_900_000_000_000;

const generalizeHelp: RevisionBodyInput = {
  type: 'operations',
  summary: 'Accept "справка" as help',
  operations: [
    {
      kind: 'generalize',
      sourceNames: ['basis.help'],
      reason: 'users ask for справка',
      intents: [
        {
          ...help,
          workflow: HELP_WORKFLOW,
          pattern: '^(?:помощь|help|справка)$',
          phrases: ['помощь', 'help', 'справка'],
          trigger_words: ['помощь', 'help', 'справка'],
        },
      ],
    },
  ],
};
const createPing: RevisionBodyInput = {
  type: 'operations',
  summary: 'Answer a ping',
  operations: [
    {
      kind: 'create',
      sourceNames: [],
      reason: 'frequent request',
      intents: [
        {
          canonical_name: 'learned.ping',
          pattern: '^(?:пинг бота)$',
          workflow: HELP_WORKFLOW,
          phrases: ['пинг бота'],
          trigger_words: ['пинг'],
          source_message: 'пинг бота',
        },
      ],
    },
  ],
};

let registry: TempRegistry;
let db: Database;
let service: IntentRevisionService;
let sessions: WorkflowSessionRepository;
const admin = adminFromTelegram(42, 42)!;

beforeEach(() => {
  registry = openTempRegistry();
  db = registry.db;
  installSeed(db, seed);
  sessions = new WorkflowSessionRepository(db);
  service = new IntentRevisionService(db, { sessions, now: () => NOW });
});
afterEach(() => registry.close());

function proposeManual(body: RevisionBodyInput) {
  const result = service.propose(body, { kind: 'manual', principal: admin });
  if (result.status !== 'created') throw new Error(`propose refused: ${result.code}`);
  return result.revision;
}
function approveRevision(id: number, principal: AdminPrincipal = admin) {
  const revision = service.get(id)!;
  return service.approve(principal, { id, bodyHash: revision.bodyHash, baseRevisionId: revision.baseRevisionId! });
}
const names = () =>
  new IntentRepository(db)
    .getApproved()
    .map((row) => row.canonical_name)
    .sort();
const manifest = () =>
  db.query<{ fingerprint: string }, []>('SELECT fingerprint FROM intent_basis_manifest').get()?.fingerprint;
function liveSession(intentId: number, createdAt: number, chatId = 7) {
  const workflow = WorkflowSchema.parse(HELP_WORKFLOW);
  sessions.set(chatId, chatId, { intentId, stepIndex: 0, stepResults: {}, workflow, captures: {}, createdAt });
}
const idOf = (name: string) =>
  db.query<{ id: number }, [string]>('SELECT id FROM intents WHERE canonical_name=?').get(name)!.id;

describe('approval', () => {
  test('approving a generalize activates exactly its target and supersedes the old revision', () => {
    const previous = service.activeRevisionId();
    const timeId = idOf('basis.time.now');
    const draft = proposeManual(generalizeHelp);
    expect(draft.status).toBe('validated');
    const result = approveRevision(draft.id);
    expect(result).toMatchObject({ status: 'active', revisionId: draft.id, removed: ['basis.help'] });
    expect(manifest()).toBe(draft.targetFingerprint!);
    expect(service.get(previous!)?.status).toBe('superseded');
    expect(service.activeRevisionId()).toBe(draft.id);
    expect(names()).toEqual(['basis.help', 'basis.time.now']);
    expect(idOf('basis.time.now')).toBe(timeId);
    const phrases = db.query<{ phrases: string }, []>("SELECT phrases FROM intents WHERE canonical_name='basis.help'");
    expect(phrases.get()?.phrases).toContain('справка');
  });

  test('an approved learned rule does not empty the catalogue', () => {
    const result = service.propose(createPing, { kind: 'learned', jobId: 'job-1' });
    if (result.status !== 'created') throw new Error(result.code);
    expect(approveRevision(result.revision.id).status).toBe('active');
    expect(names()).toEqual(['basis.help', 'basis.time.now', 'learned.ping']);
  });

  test('revise supersedes a draft without changing the running catalogue', () => {
    const draft = proposeManual(generalizeHelp);
    const before = registrySnapshot(db);
    const revised = service.revise(admin, draft.id, createPing);
    if (revised.status !== 'created') throw new Error(revised.code);
    expect(revised.revision.parentId).toBe(draft.id);
    expect(service.get(draft.id)?.status).toBe('superseded');
    expect(names()).toEqual(['basis.help', 'basis.time.now']);
    expect(JSON.parse(registrySnapshot(db)).intents).toEqual(JSON.parse(before).intents);
    const base = revised.revision.baseRevisionId!;
    expect(service.approve(admin, { id: draft.id, bodyHash: draft.bodyHash, baseRevisionId: base })).toEqual({
      status: 'refused',
      code: 'not_validated',
    });
    const id = revised.revision.id;
    expect(service.approve(admin, { id, bodyHash: draft.bodyHash, baseRevisionId: base })).toEqual({
      status: 'refused',
      code: 'hash_mismatch',
    });
    expect(service.approve(admin, { id: 999, bodyHash: draft.bodyHash, baseRevisionId: base })).toEqual({
      status: 'refused',
      code: 'not_found',
    });
  });

  test('a draft validated on a stale base is refused without mutation', () => {
    const first = proposeManual(generalizeHelp);
    const second = proposeManual(createPing);
    expect(approveRevision(first.id).status).toBe('active');
    const before = registrySnapshot(db);
    expect(approveRevision(second.id)).toEqual({ status: 'refused', code: 'conflict' });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('naming a base revision other than the active one is refused', () => {
    const draft = proposeManual(generalizeHelp);
    const before = registrySnapshot(db);
    const refused = service.approve(admin, { id: draft.id, bodyHash: draft.bodyHash, baseRevisionId: 999 });
    expect(refused).toEqual({ status: 'refused', code: 'conflict' });
    expect(registrySnapshot(db)).toBe(before);
  });
});

describe('integrity', () => {
  test('an affected row tampered after the proposal is refused and nothing changes', () => {
    const draft = proposeManual(generalizeHelp);
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.help'");
    const before = registrySnapshot(db);
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'registry_tampered' });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('a tampered unaffected rule refuses the approval too', () => {
    const draft = proposeManual(generalizeHelp);
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
    const before = registrySnapshot(db);
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'registry_tampered' });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('a tampered registry refuses new proposals', () => {
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
    const before = registrySnapshot(db);
    expect(service.propose(createPing, { kind: 'learned', jobId: 'j' })).toEqual({
      status: 'refused',
      code: 'registry_tampered',
    });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('a ledger that disagrees with the manifest refuses approval', () => {
    const draft = proposeManual(generalizeHelp);
    db.run("UPDATE intent_revisions SET target_fingerprint='0' WHERE status='active'");
    const before = registrySnapshot(db);
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'registry_unledgered' });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('an unmanaged database refuses proposals', () => {
    const fresh = openTempRegistry();
    try {
      const other = new IntentRevisionService(fresh.db, { sessions: new WorkflowSessionRepository(fresh.db) });
      expect(other.propose(createPing, { kind: 'learned', jobId: 'j' })).toEqual({
        status: 'refused',
        code: 'unmanaged',
      });
    } finally {
      fresh.close();
    }
  });
});

describe('authority', () => {
  test('only the configured administrator becomes a principal', () => {
    expect(adminFromTelegram(7, 42)).toBeNull();
    expect(adminFromTelegram(42, undefined)).toBeNull();
    expect(adminFromTelegram(0, 0)).toBeNull();
    expect(adminFromTelegram(42, 42)?.via).toBe('telegram');
    expect(adminFromOperatorCli().via).toBe('operator_cli');
  });

  test('a structurally forged principal cannot approve, revise, reject or propose manually', () => {
    const draft = proposeManual(generalizeHelp);
    const forged: AdminPrincipal = { via: 'telegram' };
    const before = registrySnapshot(db);
    expect(approveRevision(draft.id, forged)).toEqual({ status: 'refused', code: 'unauthorized' });
    expect(service.revise(forged, draft.id, createPing)).toEqual({ status: 'refused', code: 'unauthorized' });
    expect(service.reject(forged, draft.id, 'no')).toEqual({ status: 'refused', code: 'unauthorized' });
    expect(service.propose(createPing, { kind: 'manual', principal: forged })).toEqual({
      status: 'refused',
      code: 'unauthorized',
    });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('an author field inside the body never decides authorship', () => {
    const smuggled = { ...createPing, author: 'admin', decided_by: 'telegram:admin' };
    const result = service.propose(smuggled, { kind: 'learned', jobId: 'job-9' });
    if (result.status !== 'created') throw new Error(result.code);
    expect(result.revision.author).toBe('learner:job-9');
    expect(JSON.stringify(result.revision.body)).not.toContain('admin');
    expect(result.revision.decidedBy).toBeNull();
  });

  test('a source baseline body cannot be proposed as a manual or learned revision', () => {
    const body: RevisionBodyInput = { type: 'replace_all', summary: 'reset', rules: [] };
    expect(service.propose(body, { kind: 'learned', jobId: 'j' })).toEqual({ status: 'refused', code: 'invalid' });
  });

  test('reject marks a draft rejected and it can no longer be approved', () => {
    const draft = proposeManual(generalizeHelp);
    const rejected = service.reject(admin, draft.id, 'not needed');
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect(service.get(draft.id)).toMatchObject({ status: 'rejected', decidedBy: 'telegram:admin' });
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'not_validated' });
  });
});

describe('live workflow sessions', () => {
  test('a live session on an affected rule refuses approval at the exact TTL boundary', () => {
    const draft = proposeManual(generalizeHelp);
    liveSession(idOf('basis.help'), NOW - WORKFLOW_SESSION_TTL_MS + 1);
    const before = registrySnapshot(db);
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'session_active' });
    expect(registrySnapshot(db)).toBe(before);
  });

  test('a session exactly at the TTL has expired and does not block', () => {
    const draft = proposeManual(generalizeHelp);
    liveSession(idOf('basis.help'), NOW - WORKFLOW_SESSION_TTL_MS);
    expect(approveRevision(draft.id).status).toBe('active');
  });

  test('a live session with corrupt data refuses approval without throwing', () => {
    const draft = proposeManual(generalizeHelp);
    db.run('INSERT INTO workflow_sessions VALUES(?,?,?,?)', [9, 9, '{not json', NOW - 1]);
    expect(approveRevision(draft.id)).toEqual({ status: 'refused', code: 'session_unreadable' });
  });

  test('an unaffected rule keeps its id and its suspended workflow snapshot', () => {
    const draft = proposeManual(generalizeHelp);
    const timeId = idOf('basis.time.now');
    liveSession(timeId, Date.now());
    const suspended = sessions.get(7, 7);
    expect(approveRevision(draft.id).status).toBe('active');
    expect(idOf('basis.time.now')).toBe(timeId);
    expect(sessions.get(7, 7)).toEqual(suspended);
  });
});

describe('retirement', () => {
  const aiDisposition = (example: string) => ({
    example,
    disposition: 'handled_by_ai' as const,
    note: 'the AI answers this',
  });
  const retireHelp = (dispositions: ReturnType<typeof aiDisposition>[]) => ({
    kind: 'retire' as const,
    sourceNames: ['basis.help'],
    intents: [],
    reason: 'unused',
    dispositions,
  });
  const helpEnglish = {
    kind: 'create' as const,
    sourceNames: [],
    reason: 'english help',
    intents: [
      {
        canonical_name: 'manual.help_en',
        pattern: '^(?:help)$',
        workflow: HELP_WORKFLOW,
        phrases: ['help'],
        trigger_words: ['help'],
        source_message: 'help',
      },
    ],
  };
  const body = (...operations: RevisionOperationInput[]): RevisionBodyInput => ({
    type: 'operations',
    summary: 'Retire help',
    operations,
  });

  test('retiring without a disposition for every example fails validation', () => {
    const draft = proposeManual(body(retireHelp([aiDisposition('помощь')])));
    expect(draft.status).toBe('draft');
    expect(draft.validation).toEqual({
      ok: false,
      errors: ['retire of basis.help: example "help" needs exactly one disposition'],
    });
  });

  test('handled_by_ai is refused for an example that still routes to a rule', () => {
    const all = [aiDisposition('помощь'), aiDisposition('help')];
    const draft = proposeManual(body(retireHelp(all), helpEnglish));
    expect(draft.status).toBe('draft');
    expect(JSON.stringify(draft.validation)).toContain('manual.help_en');
  });

  test('covered_by names the rule that takes the example over', () => {
    const covered = { example: 'help', disposition: 'covered_by' as const, coveredBy: 'manual.help_en', note: 'moved' };
    const draft = proposeManual(
      body({ ...retireHelp([aiDisposition('помощь')]), dispositions: [aiDisposition('помощь'), covered] }, helpEnglish),
    );
    expect(draft.status).toBe('validated');
  });

  test('retiring with correct dispositions validates and removes the rule', () => {
    const draft = proposeManual(body(retireHelp([aiDisposition('помощь'), aiDisposition('help')])));
    expect(draft.status).toBe('validated');
    expect(approveRevision(draft.id).status).toBe('active');
    expect(names()).toEqual(['basis.time.now']);
  });
});

describe('source baseline', () => {
  test('startup drafts a differing source seed once and never activates it', () => {
    const active = service.activeRevisionId();
    const before = registrySnapshot(db);
    const source = [help, timeNow, seedIntents.find((rule) => rule.canonical_name === 'basis.bot.info')!];
    const draft = service.ensureSourceBaselineDraft(source);
    expect(draft).toMatchObject({ kind: 'source_baseline', status: 'validated' });
    expect(service.ensureSourceBaselineDraft(source)?.id).toBe(draft!.id);
    expect(service.activeRevisionId()).toBe(active);
    const after = JSON.parse(registrySnapshot(db));
    expect(after.intents).toEqual(JSON.parse(before).intents);
    expect(after.manifest).toEqual(JSON.parse(before).manifest);
    expect(names()).toEqual(['basis.help', 'basis.time.now']);
  });

  test('a source seed equal to the active catalogue needs no draft', () => {
    expect(service.ensureSourceBaselineDraft(seed)).toBeNull();
  });

  test('the source baseline lists every learned rule it would drop', () => {
    const learned = service.propose(createPing, { kind: 'learned', jobId: 'job-2' });
    if (learned.status !== 'created') throw new Error(learned.code);
    approveRevision(learned.revision.id);
    const draft = service.ensureSourceBaselineDraft(seed);
    expect(draft?.validation).toMatchObject({ ok: true, dropped: { learned: ['learned.ping'], manual: [] } });
    expect(names()).toContain('learned.ping');
  });

  test('an operator can approve the source baseline', () => {
    const source = [help, timeNow, seedIntents.find((rule) => rule.canonical_name === 'basis.bot.info')!];
    const draft = service.ensureSourceBaselineDraft(source)!;
    expect(approveRevision(draft.id, adminFromOperatorCli()).status).toBe('active');
    expect(names()).toEqual(['basis.bot.info', 'basis.help', 'basis.time.now']);
  });
});
