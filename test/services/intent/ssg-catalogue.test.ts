import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalogue,
  checkGeneratedFiles,
  currentSource,
  generatedFiles,
  renderHtml,
  renderMarkdown,
} from '../../../scripts/generate-intent-docs.ts';
import { canonicalMetadata, legacyDisposition, seedIntents } from '../../../src/services/intent/seed-catalog.ts';
import { seedFingerprint } from '../../../src/services/intent/seed-replacement.ts';

const docsDirectory = fileURLToPath(new URL('../../../docs/intents/', import.meta.url));
const generatorPath = fileURLToPath(new URL('../../../scripts/generate-intent-docs.ts', import.meta.url));

const countOf = (disposition: string) => legacyDisposition.filter((e) => e.disposition === disposition).length;

test('catalogue is exactly the current canonical seed, one entry per rule, none of them deployed', () => {
  const c = buildCatalogue();
  expect(c.entries.map((e) => e.name)).toEqual(seedIntents.map((s) => s.canonical_name));
  expect(new Set(c.entries.map((e) => e.name)).size).toBe(seedIntents.length);
  expect(c.entries.every((e) => e.origin === 'canonical' && e.deployed === null)).toBe(true);
  expect(c.fingerprint).toBe(seedFingerprint(seedIntents));
  expect(c.runtimeVerification).toBeNull();
  expect(c.counts.rules).toBe(canonicalMetadata.length);
});

test('every rule is fully described and its build-time routing checks pass', () => {
  for (const e of buildCatalogue().entries) {
    expect(e.issues, e.name).toEqual([]);
    expect(e.examples.length, e.name).toBeGreaterThan(0);
    expect(e.negativeExamples.length, e.name).toBeGreaterThan(0);
    expect(e.pattern, e.name).toStartWith('^');
    expect(e.workflow, e.name).toHaveProperty('steps');
    expect(e.title, e.name).toMatch(/[А-Яа-яЁё]/);
  }
});

test('lineage counts are derived from the tables, and the database cohort is a separate group', () => {
  const { source, database } = buildCatalogue().lineage;
  expect(source.total).toBe(legacyDisposition.length);
  expect(source.merge).toBe(countOf('merge'));
  expect(source.rewrite).toBe(countOf('rewrite'));
  expect(source.retire).toBe(countOf('retire'));
  expect(source.merge + source.rewrite + source.retire).toBe(source.total);
  expect(source.entries.every((e) => /[А-Яа-яЁё]/.test(e.oldTitle))).toBe(true);
  expect(database.total).toBe(database.merge + database.rewrite + database.retire);
  expect(database.entries).toHaveLength(database.total);
});

test('every earlier rule that was not retired is listed as a predecessor of exactly one rule', () => {
  const c = buildCatalogue();
  const listed = c.entries.flatMap((e) => e.predecessors.map((p) => p.key)).sort();
  expect(listed).toEqual(
    legacyDisposition
      .filter((e) => e.disposition !== 'retire')
      .map((e) => e.oldKey)
      .sort(),
  );
});

test('generator never reads the earlier candidate definitions', () => {
  expect(readFileSync(generatorPath, 'utf8')).not.toContain('intent-candidates');
});

test('source build is deterministic and does not invent database statistics', () => {
  const first = generatedFiles();
  expect(generatedFiles()).toEqual(first);
  expect(first['README.md']).toContain('целевой сид');
  expect(first['README.md']).toContain('не утверждает, что сид уже установлен');
  expect(first['index.html']).not.toContain('source_message');
});

test('every rule is readable in Markdown and has an HTML anchor and its full workflow JSON', () => {
  const c = buildCatalogue();
  const md = renderMarkdown(c);
  const html = renderHtml(c);
  for (const e of c.entries) {
    expect(md).toContain(`<a id="${e.name}"></a>`);
    expect(html).toContain(`id="${e.name}"`);
    expect(html).toContain(`data-name="${e.name}"`);
  }
  expect(md).toContain('```json');
  expect(html).toContain('id="engine"');
  expect(html).toContain('id="lineage"');
  expect(html).not.toMatch(/<(?:link|script)[^>]+(?:src|href)=["']https?:/i);
});

test('page has labelled filters', () => {
  const html = renderHtml(buildCatalogue());
  for (const id of ['search', 'category', 'risk']) expect(html).toContain(`<label for="${id}">`);
});

test('HTML and Markdown escape authored text instead of interpreting markup', () => {
  const c = buildCatalogue();
  c.entries[0]!.examples = ['<script>alert(1)</script>', '[click](javascript:alert(1))', '```', '| a | b |'];
  c.entries[0]!.notes = '<img src=x onerror=alert(1)>';
  const html = renderHtml(c);
  const md = renderMarkdown(c);
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;script&gt;');
  expect(md).toContain('&lt;script&gt;');
  expect(md).not.toContain('<img src=x');
  expect(md).not.toContain('[click](javascript:alert(1))');
  expect(md).not.toContain('\n- | a | b |');
});

test('duplicate rules or metadata cannot silently generate duplicate anchors', () => {
  const source = currentSource();
  expect(() => buildCatalogue({ ...source, seed: [...source.seed, source.seed[0]!] })).toThrow('Duplicate');
  expect(() => buildCatalogue({ ...source, metadata: [...source.metadata, source.metadata[0]!] })).toThrow('Duplicate');
});

test('a rule without metadata, or lineage pointing nowhere, fails the build', () => {
  const source = currentSource();
  expect(() => buildCatalogue({ ...source, metadata: source.metadata.slice(1) })).toThrow('differ');
  const broken = [{ ...source.lineage[0]!, target: 'basis.does.not_exist' }, ...source.lineage.slice(1)];
  expect(() => buildCatalogue({ ...source, lineage: broken })).toThrow('unknown target');
});

test('rendered totals follow the input, never a hardcoded count', () => {
  const c = buildCatalogue();
  const total = c.entries.length;
  c.entries.push({ ...c.entries[0]!, name: 'basis.synthetic_extra' });
  const html = renderHtml(c);
  expect(html).toContain(`Показано: ${total + 1} из ${total + 1}`);
  expect(html).toContain(`<b>${total + 1}</b>`);
  expect(html).not.toContain(`Показано: ${total} из ${total}`);
});

test('tracked generated files stay fresh in the normal Bun test/CI gate', () => {
  checkGeneratedFiles(docsDirectory);
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

function relativeLinks(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
  return targets.filter((target) => !/^(?:[a-z]+:|#)/i.test(target)).map((target) => target.split('#')[0]!);
}

test('every relative link in the docs resolves to a file in the repository', () => {
  const files = [
    join(docsDirectory, 'README.md'),
    join(docsDirectory, 'index.html'),
    join(docsDirectory, 'engine.md'),
    resolve(docsDirectory, '../intent-catalogue.md'),
  ];
  for (const file of files)
    for (const target of relativeLinks(file))
      expect(existsSync(resolve(dirname(file), target)), `${file} -> ${target}`).toBe(true);
});
