// Digest of the sources that decide what an intent message does. The KPI gate records it, and CI refuses a gate that
// was measured on different engine code, so a change to matching or execution cannot ride on stale numbers.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ENGINE_DIR = 'src/services/intent';
const EXTRA_FILES = ['src/bot/pipeline/intent-matcher-layer.ts'];
/** Revision, activation and backup plumbing never changes how a message is answered. */
const EXCLUDED = /^(?:revision-|kpi-gate|seed-activation|db-backup|rule-fingerprint|seed-replacement|seed-lineage)/;

export function engineFiles(): string[] {
  const files = readdirSync(join(ROOT, ENGINE_DIR))
    .filter((name) => name.endsWith('.ts') && !EXCLUDED.test(name))
    .map((name) => `${ENGINE_DIR}/${name}`);
  return [...files, ...EXTRA_FILES].sort();
}

export function engineDigest(): string {
  const hash = createHash('sha256');
  for (const file of engineFiles()) {
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(join(ROOT, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
