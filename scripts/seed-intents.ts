// Legacy entrypoint kept for operator compatibility; never upsert/approve implicitly.
// Plan: bun --no-env-file scripts/seed-intents.ts --db existing.sqlite
// Apply requires the same explicit fingerprint and fresh-backup flags as replacement.
import { runSeedReplacementCli } from './replace-intent-basis.ts';

try {
  runSeedReplacementCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Seed migration failed');
  process.exitCode = 1;
}
