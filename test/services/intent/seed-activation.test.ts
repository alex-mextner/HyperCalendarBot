// Deploy-time activation of the build's seed once its KPI gate passed: exactly this fingerprint, once,
// after a verified backup, through the ordinary approval path, and never again after a rollback.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { WorkflowSessionRepository } from '../../../src/database/repositories/workflow-session.repository.ts';
import { IntentMatcher } from '../../../src/services/intent/intent-matcher.ts';
import type { KpiGate, KpiGateRead } from '../../../src/services/intent/kpi-gate.ts';
import { adminFromOperatorCli, IntentRevisionService } from '../../../src/services/intent/revision-service.ts';
import { seedFingerprint } from '../../../src/services/intent/rule-fingerprint.ts';
import { type ActivationInput, activateGatedSeed } from '../../../src/services/intent/seed-activation.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';
import type { CanonicalSeed } from '../../../src/services/intent/seed-replacement.ts';
import { WorkflowSchema } from '../../../src/services/intent/workflow-schema.ts';
import { installSeed, openTempRegistry, registrySnapshot, type TempRegistry } from '../../helpers/intent-registry.ts';
import { passingGate } from '../../helpers/kpi-gate-fixture.ts';

// Validating a catalogue that holds the large bot-info rule takes seconds on a busy machine.
setDefaultTimeout(30_000);

const HELP_WORKFLOW = { version: 2, steps: [{ call: 'get_bot_info', input: {} }] };
const help: CanonicalSeed = {
  canonical_name: 'basis.help',
  pattern: '^(?:помощь|help)$',
  phrases: ['помощь', 'help'],
  trigger_words: ['помощь', 'help'],
  source_message: 'помощь',
  workflow: HELP_WORKFLOW,
};
const helpWithSpravka: CanonicalSeed = {
  ...help,
  pattern: '^(?:помощь|help|справка)$',
  phrases: ['помощь', 'help', 'справка'],
  trigger_words: ['помощь', 'help', 'справка'],
};
const timeNow = seedIntents.find((rule) => rule.canonical_name === 'basis.time.now')!;
const botInfo = seedIntents.find((rule) => rule.canonical_name === 'basis.bot.info')!;
const oldSeed = [help, timeNow];
const newSeed = [helpWithSpravka, timeNow, botInfo];
const NOW = 1_900_000_000_000;
const FP8 = seedFingerprint(newSeed).slice(0, 8);

function gateFor(seed: readonly CanonicalSeed[], change: (gate: KpiGate) => void = () => {}): KpiGate {
  const gate = passingGate(seedFingerprint(seed));
  change(gate);
  return gate;
}
const ok = (gate: KpiGate): KpiGateRead => ({ status: 'ok', gate });

interface LogLine {
  level: 'info' | 'warn';
  fields: { outcome?: string };
  message: string;
}

let registry: TempRegistry;
let db: Database;
let dataDir: string;
let sessions: WorkflowSessionRepository;
let service: IntentRevisionService;
let lines: LogLine[];

beforeEach(() => {
  registry = openTempRegistry();
  db = registry.db;
  installSeed(db, oldSeed);
  dataDir = mkdtempSync(join(tmpdir(), 'seed-activation-'));
  sessions = new WorkflowSessionRepository(db);
  service = new IntentRevisionService(db, { sessions, now: () => NOW });
  lines = [];
});
afterEach(() => {
  registry.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const log = {
  info: (fields: object, message: string) => lines.push({ level: 'info', fields, message }),
  warn: (fields: object, message: string) => lines.push({ level: 'warn', fields, message }),
};
function activate(override: Partial<ActivationInput> = {}) {
  return activateGatedSeed({
    db,
    dataDir,
    seed: newSeed,
    gate: ok(gateFor(newSeed)),
    sessions,
    now: () => NOW,
    log,
    ...override,
  });
}
/** What a boot does before activation: record the build's seed as a draft. */
const recordDraft = (seed: readonly CanonicalSeed[] = newSeed) => service.ensureSourceBaselineDraft(seed)!;
const backups = () => {
  const directory = join(dataDir, 'intent-basis-backups');
  return existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.sqlite')) : [];
};
const approvedNames = () =>
  new IntentRepository(db)
    .getApproved()
    .map((row) => row.canonical_name)
    .sort();

describe('activation', () => {
  test('activates the gated seed exactly once and records the deploy gate as the decider', () => {
    const baseline = service.activeRevisionId()!;
    const draft = recordDraft();
    const result = activate();
    expect(result).toMatchObject({ status: 'activated', revisionId: draft.id, fingerprint: seedFingerprint(newSeed) });
    expect(approvedNames()).toEqual(['basis.bot.info', 'basis.help', 'basis.time.now']);
    expect(service.get(draft.id)).toMatchObject({
      status: 'active',
      decidedBy: `deploy_gate:6:${FP8}`,
      decidedAt: NOW,
    });
    expect(service.get(baseline)?.status).toBe('superseded');
    expect(
      db.query<{ fingerprint: string }, []>('SELECT fingerprint FROM intent_basis_manifest').get()?.fingerprint,
    ).toBe(seedFingerprint(newSeed));
  });

  test('a second boot is a no-op that writes nothing and takes no second backup', () => {
    recordDraft();
    expect(activate().status).toBe('activated');
    const before = registrySnapshot(db);
    expect(activate()).toEqual({ status: 'already_active', fingerprint: seedFingerprint(newSeed) });
    expect(registrySnapshot(db)).toBe(before);
    expect(backups()).toHaveLength(1);
  });

  test('logs exactly one structured line per boot with the outcome', () => {
    recordDraft();
    activate();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', fields: { outcome: 'activated' } });
    lines.length = 0;
    activate();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', fields: { outcome: 'already_active' } });
  });

  test('the matcher loaded after activation routes the new rule without a restart', () => {
    const before = new IntentMatcher();
    before.load(new IntentRepository(db).getApproved());
    expect(before.match('справка')).toBeNull();
    recordDraft();
    activate();
    const after = new IntentMatcher();
    after.load(new IntentRepository(db).getApproved());
    expect(after.match('справка')).not.toBeNull();
  });
});

describe('backup', () => {
  test('is taken before the write, checked, named by seed and time, and holds the pre-activation rows', () => {
    recordDraft();
    const result = activate();
    expect(result.status).toBe('activated');
    const [name] = backups();
    expect(backups()).toHaveLength(1);
    expect(name).toMatch(new RegExp(`^calendar-before-seed-${FP8}-\\d{8}T\\d{6}Z\\.sqlite$`));
    if (result.status === 'activated') expect(result.backup).toBe(join(dataDir, 'intent-basis-backups', name!));
    const saved = new Database(join(dataDir, 'intent-basis-backups', name!), { readonly: true });
    try {
      expect(saved.query<{ quick_check: string }, []>('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      const rows = saved
        .query<{ canonical_name: string }, []>('SELECT canonical_name FROM intents ORDER BY canonical_name')
        .all()
        .map((row) => row.canonical_name);
      expect(rows).toEqual(['basis.help', 'basis.time.now']);
    } finally {
      saved.close();
    }
  });

  test('a backup that cannot be written stops the activation before any registry write', () => {
    recordDraft();
    const blocker = join(dataDir, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const before = registrySnapshot(db);
    const result = activate({ dataDir: blocker });
    expect(result.status).toBe('backup_failed');
    expect(registrySnapshot(db)).toBe(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', fields: { outcome: 'backup_failed' } });
  });
});

describe('the gate', () => {
  const untouched = (result: { status: string }, status: string) => {
    expect(result.status).toBe(status);
    expect(backups()).toEqual([]);
    expect(approvedNames()).toEqual(['basis.help', 'basis.time.now']);
  };

  test('a failing metric leaves the registry untouched and takes no backup', () => {
    recordDraft();
    const before = registrySnapshot(db);
    const result = activate({ gate: ok(gateFor(newSeed, (gate) => (gate.real.harmfulFalseMatches = 1))) });
    untouched(result, 'gate_failed');
    expect(registrySnapshot(db)).toBe(before);
    expect(lines[0]).toMatchObject({ level: 'warn', fields: { outcome: 'gate_failed' } });
  });

  test('a gate for another seed does not activate this one', () => {
    recordDraft();
    untouched(activate({ gate: ok(gateFor(oldSeed)) }), 'gate_failed');
  });

  test('autoActivate false leaves activation to the administrator', () => {
    recordDraft();
    untouched(activate({ gate: ok(gateFor(newSeed, (gate) => (gate.autoActivate = false))) }), 'gate_failed');
  });

  test('a missing gate file activates nothing', () => {
    recordDraft();
    untouched(activate({ gate: { status: 'missing' } }), 'no_gate');
  });

  test('an invalid gate file activates nothing', () => {
    recordDraft();
    untouched(activate({ gate: { status: 'invalid', reason: 'bad' } }), 'gate_invalid');
  });

  test('a seed with no recorded draft is not activated', () => {
    untouched(activate(), 'no_draft');
  });

  test('a rejected draft is not activated', () => {
    const draft = recordDraft();
    service.reject(adminFromOperatorCli(), draft.id, 'not now');
    untouched(activate(), 'no_draft');
  });
});

describe('after a rollback', () => {
  test('the same fingerprint is never re-activated automatically', () => {
    const first = service.activeRevisionId()!;
    recordDraft();
    expect(activate().status).toBe('activated');

    const operator = adminFromOperatorCli();
    const restore = service.proposeRestore(operator, first);
    if (restore.status !== 'created') throw new Error(restore.code);
    const approved = service.approve(operator, {
      id: restore.revision.id,
      bodyHash: restore.revision.bodyHash,
      baseRevisionId: restore.revision.baseRevisionId!,
    });
    expect(approved.status).toBe('active');
    expect(approvedNames()).toEqual(['basis.help', 'basis.time.now']);

    // The next boot records the build's seed again; the gate still passes for it.
    recordDraft();
    const before = registrySnapshot(db);
    const result = activate();
    expect(result).toEqual({ status: 'previously_decided', fingerprint: seedFingerprint(newSeed) });
    expect(registrySnapshot(db)).toBe(before);
    expect(backups()).toHaveLength(1);
    expect(approvedNames()).toEqual(['basis.help', 'basis.time.now']);
  });
});

describe('guards', () => {
  test('a live suspended workflow on a replaced rule defers the activation to the next boot', () => {
    recordDraft();
    const helpId = db.query<{ id: number }, []>("SELECT id FROM intents WHERE canonical_name='basis.help'").get()!.id;
    sessions.set(7, 7, {
      intentId: helpId,
      stepIndex: 0,
      stepResults: {},
      workflow: WorkflowSchema.parse(HELP_WORKFLOW),
      captures: {},
      createdAt: NOW,
    });
    const before = registrySnapshot(db);
    const result = activate();
    expect(result).toEqual({ status: 'deferred', code: 'session_active' });
    expect(registrySnapshot(db)).toBe(before);
    expect(backups()).toEqual([]);
    expect(lines[0]).toMatchObject({ level: 'warn', fields: { outcome: 'deferred' } });

    sessions.delete(7, 7);
    expect(activate().status).toBe('activated');
  });

  test('a tampered registry is refused without a backup or a write', () => {
    recordDraft();
    db.run("UPDATE intents SET phrases='[\"tampered\"]' WHERE canonical_name='basis.time.now'");
    const before = registrySnapshot(db);
    expect(activate()).toEqual({ status: 'registry_refused', state: 'tampered' });
    expect(registrySnapshot(db)).toBe(before);
    expect(backups()).toEqual([]);
  });

  test('an unmanaged registry is refused', () => {
    const bare = openTempRegistry();
    try {
      const result = activate({ db: bare.db, sessions: new WorkflowSessionRepository(bare.db) });
      expect(result).toEqual({ status: 'registry_refused', state: 'unmanaged' });
      expect(backups()).toEqual([]);
    } finally {
      bare.close();
    }
  });
});
