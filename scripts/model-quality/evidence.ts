// scripts/model-quality/evidence.ts
// What a run records about itself, so a number can be traced to the exact source, prompt, tools, fixtures
// and settings that produced it (AGENTS.md "Benchmark retention"): a manifest written once before the first
// request, and a checksum list written once after the last. Nothing here holds a credential or a private
// conversation: fixtures are synthetic, and candidates are described without their key variable.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPAIR_RETRY_NUDGE } from '../../src/services/ai/repair-nudge.ts';
import { TOTAL_BUDGET_CAP_USD } from './budget.ts';
import { fixtures } from './fixtures.ts';
import { instructions } from './light-cases.ts';
import { type Candidate, candidateId } from './models.ts';
import { promptFor, tools } from './sandbox.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface GitInfo {
  sha: string;
  tree: string;
  /** Tracked files under the harness or the bot source that differ from HEAD; empty for a clean run. */
  dirtyPaths: string[];
}

export function gitInfo(): GitInfo {
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', ...args], { stdout: 'pipe' })
      .stdout.toString()
      .trim();
  return {
    sha: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    dirtyPaths: git('status', '--porcelain', '--', 'scripts/model-quality', 'src').split('\n').filter(Boolean),
  };
}

export interface ManifestInput {
  git: GitInfo;
  at: string;
  candidates: Candidate[];
  roles: string[];
  caseIds: string[];
  repeats: number;
  lightRepeats: number;
  budgetUsd: number;
  alreadySpentUsd: number;
  mode: 'full' | 'lazy';
  maxRounds: number;
}

export function buildManifest(input: ManifestInput) {
  return {
    at: input.at,
    source: input.git,
    fixturesSha256: sha256(JSON.stringify(fixtures)),
    promptSha256: sha256(fixtures.map((f) => promptFor(f)).join('\n---\n')),
    toolsSha256: sha256(JSON.stringify(tools)),
    toolCount: tools.length,
    repairNudgeSha256: sha256(REPAIR_RETRY_NUDGE),
    lightInstructionsSha256: sha256(JSON.stringify(instructions)),
    roles: input.roles,
    caseIds: input.caseIds,
    repeats: input.repeats,
    lightRepeats: input.lightRepeats,
    toolSchemaMode: input.mode,
    maxRounds: input.maxRounds,
    candidates: input.candidates.map((c) => ({
      id: candidateId(c),
      preset: c.preset.id,
      provider: c.provider,
      model: c.model,
      effort: c.preset.effort ?? null,
      temperature: c.preset.temperature ?? null,
      maxOutputTokens: c.preset.maxOutputTokens ?? null,
      price: c.price,
    })),
    budget: { capUsd: input.budgetUsd, alreadySpentUsd: input.alreadySpentUsd, runWideCapUsd: TOTAL_BUDGET_CAP_USD },
    transcriptPolicy:
      'One provider per transcript; the provider assistant message is kept in memory only; no fallback chain',
    scope: {
      privateHistorySent: false,
      productionSideEffects: false,
      fixtures: 'synthetic scenarios transformed from task families, not a replay of retained history',
      qualification: null,
    },
  };
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .filter((name) => name !== 'SHA256SUMS')
    .sort();
}

/** Writes `SHA256SUMS` once for every file in `dir`; an existing list is never replaced. */
export function writeChecksums(dir: string): void {
  const lines = filesUnder(dir).map((name) => `${sha256(readFileSync(join(dir, name), 'utf8'))}  ${name}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
}
