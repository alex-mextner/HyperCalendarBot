import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { IntentRepository } from '../../../src/database/repositories/intent.repository.ts';
import { intentRows } from '../../../src/services/intent/seed-replacement.ts';
import { sidecarPathFor } from '../../../src/services/intent-learning/constants.ts';
import { IntentLearningError } from '../../../src/services/intent-learning/context.ts';
import type { ManualProposal } from '../../../src/services/intent-learning/schemas.ts';
import type { IntentLearningService } from '../../../src/services/intent-learning/service.ts';
import { ADMIN_ID, draft, type Fixture, makeFixture, SEED } from './helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture({ seed: true });
});
afterEach(() => fx.cleanup());

const admin = { kind: 'telegram' as const, userId: ADMIN_ID };

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof IntentLearningError) return err.code;
    throw err;
  }
  throw new Error('expected an IntentLearningError');
}

function names(): string[] {
  return intentRows(fx.db)
    .filter((row) => row.status === 'approved')
    .map((row) => row.canonical_name)
    .sort();
}

const generalizeHelp: ManualProposal = {
  summary: 'Add a Russian synonym to help',
  operations: [
    {
      kind: 'generalize',
      sourceNames: ['basis.help'],
      intents: [draft('basis.help', ['помощь', 'help', 'справка'])],
      reason: 'Users ask for справка',
    },
  ],
};

const consolidate: ManualProposal = {
  summary: 'Merge help and about',
  operations: [
    {
      kind: 'consolidate',
      sourceNames: ['basis.help', 'basis.about'],
      intents: [draft('help_about', ['помощь', 'help', 'about', 'about bot'])],
      reason: 'Same answer',
    },
  ],
};

const createVersion: ManualProposal = {
  summary: 'Answer bot version',
  operations: [{ kind: 'create', sourceNames: [], intents: [draft('bot_version', ['bot version'])], reason: 'New' }],
};

function propose(service: IntentLearningService, proposal: ManualProposal) {
  return service.createManualProposal(proposal, admin);
}

describe('admin approval gate', () => {
  test('a pending manual proposal does not touch active intents', () => {
    const service = fx.open();
    const before = intentRows(fx.db);
    const pending = propose(service, generalizeHelp);
    expect(service.getProposal(pending.id)?.status).toBe('awaiting_admin');
    expect(intentRows(fx.db)).toEqual(before);
  });

  test('only the configured admin with the exact hash can activate', () => {
    const service = fx.open();
    const { id, hash } = propose(service, createVersion);
    const stranger = { kind: 'telegram' as const, userId: ADMIN_ID + 1 };
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: hash, actor: stranger }))).toBe('forbidden');
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: 'f'.repeat(64), actor: admin }))).toBe(
      'hash_mismatch',
    );
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: hash.slice(0, 8), actor: admin }))).toBe(
      'hash_mismatch',
    );
    expect(names()).toEqual(['basis.about', 'basis.help']);
    const unconfigured = fx.open({ adminId: null });
    expect(errorCode(() => unconfigured.approve({ proposalId: id, expectedHash: hash, actor: admin }))).toBe(
      'forbidden',
    );
    expect(service.approve({ proposalId: id, expectedHash: hash.slice(0, 16), actor: admin }).status).toBe('active');
    expect(names()).toEqual(['basis.about', 'basis.help', 'bot_version']);
  });

  test('a non-admin cannot author a manual proposal either', () => {
    const service = fx.open();
    expect(errorCode(() => service.createManualProposal(createVersion, { kind: 'cli', userId: 1 }))).toBe('forbidden');
    expect(service.listProposals()).toHaveLength(0);
  });

  test('cardinality and routing are validated before a proposal can wait for the admin', () => {
    const service = fx.open();
    const twoSources = {
      ...generalizeHelp,
      operations: [{ ...generalizeHelp.operations[0]!, sourceNames: ['basis.help', 'basis.about'] }],
    };
    expect(errorCode(() => propose(service, twoSources))).toBe('validation_failed');
    const twice: ManualProposal = {
      summary: 'Affect help twice',
      operations: [
        generalizeHelp.operations[0]!,
        { ...createVersion.operations[0]!, kind: 'retire', intents: [], sourceNames: ['basis.help'] },
      ],
    };
    expect(errorCode(() => propose(service, twice))).toBe('validation_failed');
    const collides: ManualProposal = {
      summary: 'Steal about',
      operations: [{ kind: 'create', sourceNames: [], intents: [draft('about_copy', ['about'])], reason: 'dup' }],
    };
    expect(errorCode(() => propose(service, collides))).toBe('validation_failed');
    const unanchored: ManualProposal = {
      summary: 'Loose matcher',
      operations: [
        {
          kind: 'create',
          sourceNames: [],
          intents: [{ ...draft('loose', ['bot build']), pattern: 'bot build' }],
          reason: 'x',
        },
      ],
    };
    expect(errorCode(() => propose(service, unanchored))).toBe('validation_failed');
    expect(service.listProposals()).toHaveLength(0);
  });
});

describe('activation', () => {
  test('1→1 generalization moves the manifest; the evolved registry loads after reopen', () => {
    const service = fx.open();
    const { id, hash } = propose(service, generalizeHelp);
    const result = service.approve({ proposalId: id, expectedHash: hash, actor: admin });
    const manifest = fx.db.query('SELECT fingerprint FROM intent_basis_manifest').get();
    expect(manifest).toEqual({ fingerprint: result.targetFingerprint });
    service.close();
    const reopened = new IntentRepository(fx.db, SEED);
    expect(reopened.getApproved().find((row) => row.canonical_name === 'basis.help')?.phrases).toBe(
      '["помощь","help","справка"]',
    );
    expect(new IntentRepository(fx.db, SEED, () => false).getApproved()).toEqual([]);
  });

  test('M→1 consolidation replaces both sources in one transaction', () => {
    const service = fx.open();
    const { id, hash } = propose(service, consolidate);
    service.approve({ proposalId: id, expectedHash: hash, actor: admin });
    expect(names()).toEqual(['help_about']);
  });

  test('a batch that cannot fully apply changes nothing', () => {
    const service = fx.open();
    const batch: ManualProposal = {
      summary: 'Create version, retire about',
      operations: [
        createVersion.operations[0]!,
        { kind: 'retire', sourceNames: ['basis.about'], intents: [], reason: 'Unused' },
      ],
    };
    const { id, hash } = propose(service, batch);
    const aboutId = intentRows(fx.db).find((row) => row.canonical_name === 'basis.about')!.id;
    fx.db.run('INSERT INTO workflow_sessions VALUES (?, ?, ?, ?)', [
      1,
      1,
      JSON.stringify({ intentId: aboutId }),
      Date.now(),
    ]);
    const before = intentRows(fx.db);
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: hash, actor: admin }))).toBe(
      'activation_refused',
    );
    expect(intentRows(fx.db)).toEqual(before);
    expect(service.getProposal(id)?.status).toBe('awaiting_admin');
    fx.db.run('DELETE FROM workflow_sessions');
    service.approve({ proposalId: id, expectedHash: hash, actor: admin });
    expect(names()).toEqual(['basis.help', 'bot_version']);
  });

  test('drift of active rows outside the ledger blocks activation and loading', () => {
    const service = fx.open();
    const { id, hash } = propose(service, createVersion);
    fx.db.run(
      'UPDATE intents SET phrases = \'["about","about bot","unreviewed"]\' WHERE canonical_name = \'basis.about\'',
    );
    const before = intentRows(fx.db);
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: hash, actor: admin }))).toBe(
      'activation_refused',
    );
    expect(intentRows(fx.db)).toEqual(before);
    expect(new IntentRepository(fx.db, SEED).getApproved()).toEqual([]);
  });

  test('an unrelated earlier activation rebases; one touching the same source is a conflict', () => {
    const service = fx.open();
    const version = propose(service, createVersion);
    const help = propose(service, generalizeHelp);
    const merge = propose(service, consolidate);
    service.approve({ proposalId: version.id, expectedHash: version.hash, actor: admin });
    expect(service.approve({ proposalId: help.id, expectedHash: help.hash, actor: admin }).rebased).toBe(true);
    expect(errorCode(() => service.approve({ proposalId: merge.id, expectedHash: merge.hash, actor: admin }))).toBe(
      'activation_refused',
    );
    expect(service.getProposal(merge.id)?.status).toBe('conflict');
    expect(names()).toEqual(['basis.about', 'basis.help', 'bot_version']);
  });

  test('recovery acknowledges a committed revision by fingerprint and never writes the main database', () => {
    const service = fx.open();
    const { id, hash } = propose(service, createVersion);
    service.approve({ proposalId: id, expectedHash: hash, actor: admin });
    service.close();
    const sidecar = new Database(sidecarPathFor(fx.dbPath));
    sidecar.run("UPDATE revisions SET status = 'activating', acked_at = NULL");
    sidecar.run("UPDATE proposals SET status = 'activating'");
    sidecar.close();
    expect(new IntentRepository(fx.db, SEED).getApproved()).toHaveLength(3);
    const before = intentRows(fx.db);
    const reopened = fx.open();
    expect(reopened.getProposal(id)?.status).toBe('active');
    expect(intentRows(fx.db)).toEqual(before);
  });

  test('recovery abandons a revision whose main commit never happened', () => {
    const service = fx.open();
    const { id, hash } = propose(service, createVersion);
    const proposal = service.getProposal(id)!;
    service.close();
    const sidecar = new Database(sidecarPathFor(fx.dbPath));
    sidecar.run(
      "INSERT INTO revisions(proposal_id, root_fingerprint, base_fingerprint, target_fingerprint, status, actor, created_at) VALUES (?, NULL, ?, ?, 'activating', 'test', 0)",
      [id, proposal.baseFingerprint, proposal.targetFingerprint],
    );
    sidecar.run("UPDATE proposals SET status = 'activating' WHERE id = ?", [id]);
    sidecar.close();
    const before = intentRows(fx.db);
    const reopened = fx.open();
    expect(reopened.getProposal(id)?.status).toBe('awaiting_admin');
    expect(intentRows(fx.db)).toEqual(before);
    expect(reopened.approve({ proposalId: id, expectedHash: hash, actor: admin }).status).toBe('active');
  });

  test('a rejected proposal can no longer be approved', () => {
    const service = fx.open();
    const { id, hash } = propose(service, createVersion);
    service.reject({ proposalId: id, actor: admin, reason: 'not needed' });
    expect(errorCode(() => service.approve({ proposalId: id, expectedHash: hash, actor: admin }))).toBe(
      'invalid_state',
    );
    expect(names()).toEqual(['basis.about', 'basis.help']);
  });
});
