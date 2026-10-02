import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import {
  applySeedReplacement,
  type CanonicalSeed,
  planSeedReplacement,
} from '../../../src/services/intent/seed-replacement.ts';
import type { IntentLearningLimits } from '../../../src/services/intent-learning/constants.ts';
import type {
  Comparison,
  GenerationArtifact,
  IntentDraft,
  ReviewArtifact,
} from '../../../src/services/intent-learning/schemas.ts';
import { IntentLearningService } from '../../../src/services/intent-learning/service.ts';

export const ADMIN_ID = 5001;
const WORKFLOW = { version: 2, steps: [{ call: 'get_bot_info', input: {} }] };

export const SEED: CanonicalSeed[] = [
  {
    canonical_name: 'basis.help',
    pattern: '^(?:помощь|help)$',
    phrases: ['помощь', 'help'],
    trigger_words: ['помощь', 'help'],
    source_message: 'помощь',
    workflow: WORKFLOW,
  },
  {
    canonical_name: 'basis.about',
    pattern: '^(?:about|about bot)$',
    phrases: ['about', 'about bot'],
    trigger_words: ['about'],
    source_message: 'about',
    workflow: WORKFLOW,
  },
];

export interface Fixture {
  dir: string;
  dbPath: string;
  db: Database;
  clock: { now: number };
  open: (options?: { limits?: Partial<IntentLearningLimits>; adminId?: number | null }) => IntentLearningService;
  cleanup: () => void;
}

export const LOOSE_LIMITS: Partial<IntentLearningLimits> = {
  maxConcurrentLeases: 10,
  startsPerMinute: 100,
  startsPerHour: 1000,
  startsPerDay: 1000,
};

/** A real on-disk main database (so the sidecar lives next to it) and a controllable clock. */
export function makeFixture(options: { seed?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'intent-learning-'));
  const dbPath = join(dir, 'calendar.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  runMigrations(db, migrations);
  if (options.seed) {
    const plan = planSeedReplacement(db, SEED);
    const backup = join(dir, 'before-seed.db');
    db.query('VACUUM INTO ?').run(backup);
    applySeedReplacement(db, SEED, plan, backup);
  }
  const clock = { now: Date.now() };
  const opened: IntentLearningService[] = [];
  return {
    dir,
    dbPath,
    db,
    clock,
    open: (open = {}) => {
      const service = IntentLearningService.open({
        mainDb: db,
        adminId: open.adminId === undefined ? ADMIN_ID : open.adminId,
        limits: open.limits ?? LOOSE_LIMITS,
        now: () => clock.now,
        random: () => 0.5,
        sourceSeed: SEED,
      });
      opened.push(service);
      return service;
    },
    cleanup: () => {
      for (const service of opened) {
        try {
          service.close();
        } catch {
          // Already closed by the test itself.
        }
      }
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function draft(name: string, phrases: string[]): IntentDraft {
  return {
    canonical_name: name,
    pattern: `^(?:${phrases.join('|')})$`,
    workflow: WORKFLOW,
    phrases,
    trigger_words: [...new Set(phrases.map((phrase) => phrase.split(' ')[0]!))],
    source_message: phrases[0]!,
  };
}

export function comparison(sampleId: number, verdict: Comparison['verdict'] = 'better'): Comparison {
  return {
    sampleId,
    previousAiResponse: 'model-claimed previous answer',
    intentResponse: 'Bot information',
    idealResponse: 'Bot information',
    expectedTools: ['get_bot_info'],
    verdict,
    rationale: 'Same tool, no model call',
    quality: {
      friendliness: 2,
      informativeness: 2,
      relevance: 2,
      grounding: 2,
      notes: ['Synthetic reviewed fixture: direct, natural and supported.'],
    },
  };
}

export function generation(sampleIds: number[], phrases = ['bot version please']): GenerationArtifact {
  return {
    kind: 'proposal',
    summary: 'Answer bot version requests directly',
    operations: [{ kind: 'create', sourceNames: [], intents: [draft('bot_version', phrases)], reason: 'Repeated' }],
    comparisons: sampleIds.map((id) => comparison(id)),
  };
}

export function review(proposalHash: string, sampleIds: number[], overrides: Partial<ReviewArtifact> = {}) {
  const artifact: ReviewArtifact = {
    kind: 'review',
    proposalHash,
    verdict: 'pass',
    findings: [],
    comparisons: sampleIds.map((id) => comparison(id)),
    ...overrides,
  };
  return artifact;
}

export function interaction(chatId: number, request = 'bot version please', actorId = chatId) {
  return {
    actorId,
    chatId,
    messageId: 1,
    request,
    previousAiResponse: `Stored AI answer for ${request}`,
    toolCalls: [{ name: 'get_bot_info', input: {} }],
    toolResults: [{ success: true, output: 'v1' }],
    recentMessages: [],
  };
}

let sessionCounter = 0;
export function freshSession(): string {
  sessionCounter++;
  return `session-${sessionCounter}-${Math.random().toString(36).slice(2)}`;
}
