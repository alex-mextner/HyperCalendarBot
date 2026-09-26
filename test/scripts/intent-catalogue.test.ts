import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderIntentCatalogue } from '../../scripts/intent-catalogue-page.ts';
import { syntheticIntentSnapshot } from '../../scripts/preview-intent-catalogue.ts';
import { canonicalMetadata, seedIntents } from '../../src/services/intent/seed-catalog.ts';

const ROOT = join(import.meta.dir, '../..');
const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

test('the catalogue page shows one titled card per shipped seed intent', () => {
  const html = renderIntentCatalogue(syntheticIntentSnapshot(), true);
  expect(html.match(/<article class="seed"/g)?.length).toBe(seedIntents.length);
  for (const meta of canonicalMetadata) expect(html).toContain(`<h3>${escapeHtml(meta.title)}</h3>`);
  expect(html).toContain(`Из коробки: ${seedIntents.length} `);
  expect(html).not.toContain('шесть сценариев');
  expect(html).not.toContain('Нет в текущем каноническом каталоге');
});

test('verify-intent-catalogue passes on the page the preview just wrote', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hcb-catalogue-verify-'));
  try {
    const run = (script: string) =>
      spawnSync(process.execPath, ['--no-env-file', script, directory], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
    const preview = run('scripts/preview-intent-catalogue.ts');
    expect({ status: preview.status, stderr: preview.stderr }).toEqual({ status: 0, stderr: '' });
    const verify = run('scripts/verify-intent-catalogue.ts');
    expect({ status: verify.status, stderr: verify.status === 0 ? '' : verify.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    const report = JSON.parse(verify.stdout.trim().split('\n').at(-1)!);
    expect(report.cards).toBe(seedIntents.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
