import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogue } from '../../../scripts/generate-intent-docs.ts';

test('committed intent page works in actual Chromium in the ordinary CI gate', () => {
  const output = mkdtempSync(join(tmpdir(), 'hcb-ssg-browser-'));
  try {
    // A separate process avoids importing global mocks from other test suites.
    const run = spawnSync(
      process.execPath,
      ['--no-env-file', fileURLToPath(new URL('../../../scripts/verify-intent-docs.ts', import.meta.url)), output],
      {
        encoding: 'utf8',
        timeout: 45000,
      },
    );
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const catalogue = buildCatalogue();
    expect(JSON.parse(run.stdout)).toMatchObject({
      catalogue: catalogue.entries.length,
      lineage: { source: catalogue.lineage.source.total, database: catalogue.lineage.database.total },
      search: true,
      filters: true,
      details: true,
      engine: true,
      desktopOverflow: false,
      mobileOverflow: false,
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 60000);
