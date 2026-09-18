import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalogue,
  checkGeneratedFiles,
  generatedFiles,
  renderHtml,
  renderMarkdown,
} from '../../../scripts/generate-intent-docs.ts';
import { seedIntents } from '../../../src/services/intent/seed-catalog.ts';

test('SSG includes actual active seed and recovered104 unique definitions without activating candidates', () => {
  const c = buildCatalogue();
  expect(c.entries.length).toBe(104);
  expect(new Set(c.entries.map((x) => x.name)).size).toBe(104);
  expect(c.entries.filter((x) => x.origin === 'active').map((x) => x.name)).toEqual(
    seedIntents.map((s) => s.canonical_name),
  );
  expect(c.entries.filter((x) => x.origin === 'candidate')).toHaveLength(98);
  expect(c.entries.every((x) => x.deployed === null)).toBe(true);
});
test('source build is deterministic and does not invent DB stats', () => {
  const first = generatedFiles();
  expect(generatedFiles()).toEqual(first);
  expect(first['index.html']).toContain('104');
  expect(first['README.md']).toContain('98');
  expect(first['README.md']).toContain('Статистика БД не включена');
  expect(first['index.html']).not.toContain('source_message');
});
test('every scenario is readable in Markdown and represented by an HTML anchor', () => {
  const c = buildCatalogue();
  const md = renderMarkdown(c);
  const html = renderHtml(c);
  for (const e of c.entries) {
    expect(md).toContain(`### ${e.name}`);
    expect(html).toContain(`id="${e.name}"`);
  }
  expect(md).toContain('```json');
  expect(md).toContain('Способы сопоставления');
  expect(html).not.toMatch(/<(?:link|script)[^>]+(?:src|href)=["']https?:/i);
});
test('HTML and Markdown escape authored examples instead of interpreting markup', () => {
  const c = buildCatalogue();
  c.entries[0]!.examples = ['<script>alert(1)</script>', '[click](javascript:alert(1))'];
  expect(renderHtml(c)).not.toContain('<script>alert(1)</script>');
  expect(renderHtml(c)).toContain('&lt;script&gt;');
  expect(renderMarkdown(c)).toContain('&lt;script&gt;');
  expect(renderMarkdown(c)).not.toContain('[click](javascript:alert(1))');
});

test('tracked generated files stay fresh in the normal Bun test/CI gate', () => {
  checkGeneratedFiles(fileURLToPath(new URL('../../../docs/intents/', import.meta.url)));
});
test('freshness check rejects a stale or missing generated artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-ssg-'));
  try {
    expect(() => checkGeneratedFiles(dir)).toThrow();
    const files = generatedFiles();
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    expect(() => checkGeneratedFiles(dir)).not.toThrow();
    writeFileSync(join(dir, 'README.md'), `${files['README.md']}stale`);
    expect(() => checkGeneratedFiles(dir)).toThrow('stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('all recovered scenarios have human-readable Russian task labels', () => {
  const catalogue = buildCatalogue();
  for (const entry of catalogue.entries) expect(entry.title).toMatch(/[А-Яа-яЁё]/);
});
test('duplicate candidate keys cannot silently generate duplicate anchors', () => {
  const source = JSON.parse(readFileSync(new URL('../../../scripts/intent-candidates.json', import.meta.url), 'utf8'));
  source.definitions.push(source.definitions[0]);
  expect(() => buildCatalogue(source)).toThrow('Duplicate');
});
test('rendered total and source counts follow the input, never a hardcoded104', () => {
  const catalogue = buildCatalogue();
  const candidate = catalogue.entries.find((entry) => entry.origin === 'candidate')!;
  catalogue.entries.push({ ...candidate, name: 'synthetic_extra' });
  const html = renderHtml(catalogue);
  expect(html).toContain('Все 105');
  expect(html).toContain('<b>99</b>');
  expect(html).not.toContain('Все 104');
});
