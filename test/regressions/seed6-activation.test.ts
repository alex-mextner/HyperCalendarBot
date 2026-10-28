// The production transition, end to end on the real data: a database holding revision 3's 52 rules (the rules prod runs
// today) receives this build's seed 6 through the COMMITTED kpi-gate.json, exactly as the boot path does. A seed the
// revision validator refuses, or a gate that does not match it, would otherwise leave prod silently on revision 3.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules } from '../../scripts/intent-benchmark/benchmark.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { readKpiGate } from '../../src/services/intent/kpi-gate.ts';
import { IntentRevisionService } from '../../src/services/intent/revision-service.ts';
import { seedFingerprint } from '../../src/services/intent/rule-fingerprint.ts';
import { activateGatedSeed } from '../../src/services/intent/seed-activation.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { installSeed, openTempRegistry, type TempRegistry } from '../helpers/intent-registry.ts';

setDefaultTimeout(60_000);

const REVISION_3_RULES = new URL('../../docs/intents/benchmarks/rules/revision-3.json', import.meta.url).pathname;
const NOW = 1_900_000_000_000;

let registry: TempRegistry;
let dataDir: string;
beforeAll(() => {
  registry = openTempRegistry();
  dataDir = mkdtempSync(join(tmpdir(), 'seed6-activation-'));
});
afterAll(() => {
  registry.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('seed 6 replaces revision 3 through the committed gate', () => {
  test('revision 3 has the 52 production rules and this build has a different seed', () => {
    const revision3 = loadRules(REVISION_3_RULES);
    expect(revision3).toHaveLength(52);
    installSeed(registry.db, revision3);
    expect(new IntentRepository(registry.db).getApproved()).toHaveLength(52);
    expect(seedFingerprint(revision3)).not.toBe(seedFingerprint(seedIntents));
  });

  test('the boot records seed 6 as a VALIDATED draft (the revision validator accepts every rule)', () => {
    const service = new IntentRevisionService(registry.db, { sessions: new WorkflowSessionRepository(registry.db) });
    const draft = service.ensureSourceBaselineDraft(seedIntents);
    expect(draft?.validation).toMatchObject({ ok: true });
    expect(draft).toMatchObject({ kind: 'source_baseline', status: 'validated' });
  });

  test('the committed gate passes, activates seed 6 once, takes a backup and routes the new rules', () => {
    const gate = readKpiGate();
    expect(gate.status).toBe('ok');
    const lines: { fields: object }[] = [];
    const log = {
      info: (fields: object) => lines.push({ fields }),
      warn: (fields: object) => lines.push({ fields }),
    };
    const result = activateGatedSeed({
      db: registry.db,
      dataDir,
      seed: seedIntents,
      gate,
      sessions: new WorkflowSessionRepository(registry.db),
      now: () => NOW,
      log,
    });
    expect(result).toMatchObject({ status: 'activated', fingerprint: seedFingerprint(seedIntents) });
    const backups = readdirSync(join(dataDir, 'intent-basis-backups'));
    expect(backups.filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
    expect(existsSync(join(dataDir, 'intent-basis-backups'))).toBe(true);

    const approved = new IntentRepository(registry.db).getApproved();
    expect(approved).toHaveLength(seedIntents.length);
    const matcher = new IntentMatcher();
    matcher.load(approved);
    // "что завтра": revision 3 never answered it as a rule (it needed the exact "что у меня завтра" form).
    const match = matcher.match('что завтра');
    expect(match).not.toBeNull();
    expect(approved.find((row) => row.id === match?.intentId)?.canonical_name).toBe('basis.calendar.day');
  });

  test('a second boot is a no-op', () => {
    const result = activateGatedSeed({
      db: registry.db,
      dataDir,
      seed: seedIntents,
      gate: readKpiGate(),
      sessions: new WorkflowSessionRepository(registry.db),
      now: () => NOW + 1000,
      log: { info: () => {}, warn: () => {} },
    });
    expect(result).toEqual({ status: 'already_active', fingerprint: seedFingerprint(seedIntents) });
  });
});
