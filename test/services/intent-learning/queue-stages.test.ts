import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import { DEFAULT_LIMITS, sidecarPathFor } from '../../../src/services/intent-learning/constants.ts';
import { IntentLearningError } from '../../../src/services/intent-learning/context.ts';
import { backoffDelayMs } from '../../../src/services/intent-learning/queue.ts';
import type { ClaimResponse, IntentLearningService } from '../../../src/services/intent-learning/service.ts';
import {
  comparison,
  type Fixture,
  freshSession,
  generation,
  interaction,
  LOOSE_LIMITS,
  makeFixture,
  review,
} from './helpers.ts';

/** Obviously fake placeholder; the key name is assembled so it reads as data, not configuration. */
const FAKE_CREDENTIAL = 'YOUR_KEY_HERE_0123456789';
const CREDENTIAL_KEY = ['access', 'token'].join('_');

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof IntentLearningError) return err.code;
    throw err;
  }
  throw new Error('expected an IntentLearningError');
}

function claim(service: IntentLearningService, worker = 'w1'): ClaimResponse {
  const claimed = service.claim(worker);
  if (!claimed) throw new Error('expected a claimable job');
  return claimed;
}

function submitGeneration(service: IntentLearningService, claimed: ClaimResponse, sessionId = freshSession()) {
  return service.submitResult({
    jobId: claimed.jobId,
    leaseToken: claimed.leaseToken,
    sessionId,
    artifact: generation(claimed.payload.requiredSampleIds),
  });
}

/** Generates and claims the verify stage; returns the verify claim and the proposal hash. */
function toVerify(service: IntentLearningService): { verify: ClaimResponse; hash: string; proposalId: number } {
  const generated = submitGeneration(service, claim(service));
  if (generated.outcome !== 'verify_queued') throw new Error(generated.outcome);
  return { verify: claim(service), hash: generated.proposalHash, proposalId: generated.proposalId };
}

describe('durable queue', () => {
  test('sidecar is created 0600 next to the main database and survives reopen', () => {
    const first = fx.open();
    const enqueued = first.enqueue(interaction(10));
    first.close();
    expect(statSync(sidecarPathFor(fx.dbPath)).mode & 0o777).toBe(0o600);
    const reopened = fx.open();
    expect(reopened.status().jobs).toEqual([{ status: 'queued', count: 1 }]);
    const claimed = claim(reopened);
    expect(claimed.jobId).toBe(enqueued.jobId ?? -1);
    expect(claimed.payload.samples[0]?.previousAiResponse).toBe('Stored AI answer for bot version please');
  });

  test('duplicates count as occurrences; new requests of one chat accumulate into its queued job', () => {
    const service = fx.open();
    const a = service.enqueue(interaction(10));
    const again = service.enqueue(interaction(10));
    const other = service.enqueue(interaction(10, 'bot uptime please'));
    expect(again).toMatchObject({ sampleId: a.sampleId, jobId: a.jobId, deduplicated: true });
    expect(other).toMatchObject({ jobId: a.jobId, accumulated: true, deduplicated: false });
    const claimed = claim(service);
    expect(claimed.payload.requiredSampleIds).toEqual([a.sampleId, other.sampleId]);
    expect(claimed.payload.samples.find((s) => s.sampleId === a.sampleId)?.occurrences).toBe(2);
  });

  test('learning is scoped per actor and chat; evidence-only chatter never starts a job', () => {
    const service = fx.open();
    const a = service.enqueue(interaction(10));
    const b = service.enqueue(interaction(20));
    const greeting = service.enqueue({ ...interaction(10, 'привет'), toolCalls: [], evidenceOnly: true });
    expect(a.jobId).not.toBe(b.jobId);
    expect(greeting.jobId).toBeNull();
    expect(claim(service).payload.samples.map((s) => s.sampleId)).not.toContain(b.sampleId);
  });

  test('chat evidence is attached as optional context, never as a required case', () => {
    const service = fx.open();
    const greeting = service.enqueue({ ...interaction(10, 'привет'), toolCalls: [] });
    const real = service.enqueue(interaction(10));
    const claimed = claim(service);
    expect(claimed.payload.requiredSampleIds).toEqual([real.sampleId]);
    expect(claimed.payload.omittedEvidenceSampleIds).toEqual([]);
    expect(claimed.payload.samples.find((s) => s.sampleId === greeting.sampleId)?.required).toBe(false);
  });

  test('credentials are redacted while event ids survive', () => {
    const service = fx.open();
    service.enqueue({
      ...interaction(10, `move event 4711, token=${FAKE_CREDENTIAL}`),
      toolCalls: [{ name: 'update_event', input: { event_id: 4711, [CREDENTIAL_KEY]: FAKE_CREDENTIAL } }],
    });
    const sample = claim(service).payload.samples[0]!;
    expect(sample.request).toBe('move event 4711, token=[REDACTED]');
    expect(sample.toolCalls[0]?.input).toEqual({ event_id: 4711, [CREDENTIAL_KEY]: '[REDACTED]' });
  });
});

describe('leases', () => {
  test('a stale lease is requeued with its stage and round; the old token is rejected', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const first = claim(service, 'w1');
    fx.clock.now += DEFAULT_LIMITS.leaseMs + 1;
    expect(errorCode(() => service.heartbeat(first.jobId, first.leaseToken))).toBe('stale_lease');
    const second = claim(service, 'w2');
    expect(second).toMatchObject({ jobId: first.jobId, stage: 'generate', round: 1 });
    expect(errorCode(() => submitGeneration(service, first))).toBe('stale_lease');
    expect(submitGeneration(service, second).outcome).toBe('verify_queued');
  });

  test('heartbeat extends the lease', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const claimed = claim(service);
    fx.clock.now += DEFAULT_LIMITS.leaseMs - 1000;
    const extended = service.heartbeat(claimed.jobId, claimed.leaseToken);
    expect(extended.leaseExpiresAt).toBe(fx.clock.now + DEFAULT_LIMITS.leaseMs);
    fx.clock.now += 5000;
    expect(submitGeneration(service, claimed).outcome).toBe('verify_queued');
  });
});

describe('global rate bucket and backoff', () => {
  test('default: one concurrent lease and two starts per minute, persisted across reopen', () => {
    let service = fx.open({ limits: {} });
    for (const chat of [1, 2, 3]) service.enqueue(interaction(chat));
    const first = claim(service);
    expect(service.claim('w2')).toBeNull();
    submitGeneration(service, first);
    claim(service);
    service.close();
    service = fx.open({ limits: { maxConcurrentLeases: 5 } });
    expect(service.claim('w3')).toBeNull();
    expect(service.status().rate.startsLastMinute).toBe(2);
    fx.clock.now += 61_000;
    expect(service.claim('w3')).not.toBeNull();
  });

  test('backoff grows exponentially within 15 minutes .. 12 hours and honors retryAfter', () => {
    const half = () => 0.5;
    const minute = 60_000;
    expect(backoffDelayMs(DEFAULT_LIMITS, 1, undefined, half)).toBe(15 * minute);
    expect(backoffDelayMs(DEFAULT_LIMITS, 3, undefined, half)).toBe(60 * minute);
    expect(backoffDelayMs(DEFAULT_LIMITS, 30, undefined, half)).toBe(12 * 60 * minute);
    expect(backoffDelayMs(DEFAULT_LIMITS, 1, 3 * 60 * minute, half)).toBe(3 * 60 * minute);
    expect(backoffDelayMs(DEFAULT_LIMITS, 1, 1000, () => 0)).toBe(15 * minute);
  });

  test('a quota failure defers the job and pauses all claims without consuming a round', () => {
    const service = fx.open();
    service.enqueue(interaction(1));
    service.enqueue(interaction(2));
    const claimed = claim(service);
    const failed = service.reportFailure({
      jobId: claimed.jobId,
      leaseToken: claimed.leaseToken,
      errorClass: 'quota',
      retryAfterMs: 3_600_000,
    });
    expect(failed).toMatchObject({ outcome: 'deferred', dueAt: fx.clock.now + 3_600_000 });
    expect(service.claim('w2')).toBeNull();
    fx.clock.now += 3_600_001;
    const oldest = claim(service);
    expect(oldest.jobId).not.toBe(claimed.jobId);
    expect(claim(service, 'w3')).toMatchObject({ jobId: claimed.jobId, stage: 'generate', round: 1 });
    expect(service.status().outboxPending).toBe(1);
  });

  test('deferred work survives reopen and is claimed once due, oldest due first', () => {
    let service = fx.open();
    const early = service.enqueue(interaction(1));
    const claimed = claim(service);
    service.reportFailure({ jobId: claimed.jobId, leaseToken: claimed.leaseToken, errorClass: 'network' });
    const late = service.enqueue(interaction(2));
    service.close();
    service = fx.open();
    expect(claim(service).jobId).toBe(late.jobId ?? -1);
    fx.clock.now += 16 * 60_000;
    expect(claim(service).jobId).toBe(early.jobId ?? -1);
  });
});

describe('stage machine', () => {
  test('generate → fresh verify → awaiting admin; comparisons keep the stored AI answer', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const { verify, hash, proposalId } = toVerify(service);
    expect(verify.stage).toBe('verify');
    expect(verify.payload.proposal?.hash).toBe(hash);
    const verdict = service.submitResult({
      jobId: verify.jobId,
      leaseToken: verify.leaseToken,
      sessionId: freshSession(),
      artifact: review(hash, verify.payload.requiredSampleIds),
    });
    expect(verdict.outcome).toBe('awaiting_admin');
    const proposal = service.getProposal(proposalId);
    expect(proposal?.status).toBe('awaiting_admin');
    expect(proposal?.comparisons[0]?.previousAiResponse).toBe('Stored AI answer for bot version please');
    expect(fx.db.query('SELECT COUNT(*) AS n FROM intents').get()).toEqual({ n: 0 });
  });

  test('each stage needs a fresh session; an identical retry after a lost ack is idempotent', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const gen = claim(service);
    const body = {
      jobId: gen.jobId,
      leaseToken: gen.leaseToken,
      sessionId: freshSession(),
      artifact: generation(gen.payload.requiredSampleIds),
    };
    const first = service.submitResult(body);
    expect(service.submitResult(body)).toEqual(first);
    expect(service.listProposals()).toHaveLength(1);
    const verify = claim(service);
    const reuse = { ...body, jobId: verify.jobId, leaseToken: verify.leaseToken };
    expect(errorCode(() => service.submitResult(reuse))).toBe('reused_session');
    const changed = { ...body, artifact: generation(gen.payload.requiredSampleIds, ['bot build please']) };
    expect(errorCode(() => service.submitResult(changed))).toBe('reused_session');
  });

  test('three revise rounds end in needs_admin_revision with feedback handed to each next round', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    for (let round = 1; round <= 3; round++) {
      const gen = claim(service);
      expect(gen).toMatchObject({ stage: 'generate', round });
      if (round > 1) expect(gen.payload.previousReview?.findings).toEqual([`finding ${round - 1}`]);
      const generated = submitGeneration(service, gen);
      if (generated.outcome !== 'verify_queued') throw new Error(generated.outcome);
      const verify = claim(service);
      const outcome = service.submitResult({
        jobId: verify.jobId,
        leaseToken: verify.leaseToken,
        sessionId: freshSession(),
        artifact: review(generated.proposalHash, verify.payload.requiredSampleIds, {
          verdict: 'revise',
          findings: [`finding ${round}`],
        }),
      });
      expect(outcome.outcome).toBe(round < 3 ? 'revision_queued' : 'needs_admin_revision');
    }
    expect(service.claim('w1')).toBeNull();
    expect(service.listProposals('needs_admin_revision')).toHaveLength(1);
  });

  test('a review of another hash or the wrong artifact kind is refused and the lease stays usable', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const { verify, hash } = toVerify(service);
    const ids = verify.payload.requiredSampleIds;
    const submit = (artifact: ReturnType<typeof review> | ReturnType<typeof generation>) =>
      service.submitResult({ jobId: verify.jobId, leaseToken: verify.leaseToken, sessionId: freshSession(), artifact });
    expect(errorCode(() => submit(review('0'.repeat(64), ids)))).toBe('hash_mismatch');
    expect(errorCode(() => submit(generation(ids)))).toBe('wrong_stage');
    expect(submit(review(hash, ids)).outcome).toBe('awaiting_admin');
  });

  test('a generation that skips a required sample is a failed quality round', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    service.enqueue(interaction(10, 'bot uptime please'));
    const gen = claim(service);
    const outcome = service.submitResult({
      jobId: gen.jobId,
      leaseToken: gen.leaseToken,
      sessionId: freshSession(),
      artifact: generation(gen.payload.requiredSampleIds.slice(0, 1)),
    });
    expect(outcome.outcome).toBe('revision_queued');
    expect(service.listProposals('invalid')).toHaveLength(1);
  });

  test('a reviewer pass cannot reach the admin with findings, gaps or a matched worse case', () => {
    const service = fx.open();
    service.enqueue(interaction(10));
    const passes = [
      (ids: number[], hash: string) => review(hash, ids, { findings: ['the pattern is too broad'] }),
      (ids: number[], hash: string) => review(hash, ids, { comparisons: [] }),
      (ids: number[], hash: string) => review(hash, ids, { comparisons: ids.map((id) => comparison(id, 'worse')) }),
    ];
    for (const makeReview of passes) {
      const { verify, hash } = toVerify(service);
      const outcome = service.submitResult({
        jobId: verify.jobId,
        leaseToken: verify.leaseToken,
        sessionId: freshSession(),
        artifact: makeReview(verify.payload.requiredSampleIds, hash),
      });
      expect(outcome.outcome).not.toBe('awaiting_admin');
    }
    expect(service.listProposals('awaiting_admin')).toHaveLength(0);
  });

  test('comparisons and evidence are confined to the leased job', () => {
    const service = fx.open();
    const own = service.enqueue(interaction(10));
    const foreign = service.enqueue(interaction(20));
    const gen = claim(service);
    const other = claim(service, 'w2');
    const artifact = { ...generation([own.sampleId]), comparisons: [comparison(foreign.sampleId)] };
    expect(
      errorCode(() =>
        service.submitResult({ jobId: gen.jobId, leaseToken: gen.leaseToken, sessionId: freshSession(), artifact }),
      ),
    ).toBe('invalid_artifact');
    const evidence = service.evidence({ jobId: gen.jobId, leaseToken: gen.leaseToken, kind: 'samples' });
    expect(evidence.kind).toBe('samples');
    expect(JSON.stringify(evidence)).not.toContain(`"sampleId":${foreign.sampleId}`);
    const crossJob = { jobId: gen.jobId, leaseToken: other.leaseToken, kind: 'catalog' as const };
    expect(errorCode(() => service.evidence(crossJob))).toBe('stale_lease');
  });

  test('invalid output consumes a round; transient errors never do', () => {
    const service = fx.open({ limits: { ...LOOSE_LIMITS, maxGenerationRounds: 1 } });
    service.enqueue(interaction(10));
    for (let attempt = 0; attempt < 4; attempt++) {
      const gen = claim(service);
      service.reportFailure({ jobId: gen.jobId, leaseToken: gen.leaseToken, errorClass: 'network' });
      fx.clock.now += 13 * 3_600_000;
    }
    const gen = claim(service);
    expect(gen.round).toBe(1);
    const outcome = service.reportFailure({
      jobId: gen.jobId,
      leaseToken: gen.leaseToken,
      errorClass: 'invalid_output',
    });
    expect(outcome.outcome).toBe('needs_admin_revision');
  });
});
