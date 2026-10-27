import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCatalogue,
  checkGeneratedFiles,
  generatedFiles,
  MAX_GENERATED_LINES,
} from '../../../scripts/generate-intent-docs.ts';
import { escapeMarkdown, lineCount } from '../../../scripts/intent-doc-text.ts';

const docsDirectory = fileURLToPath(new URL('../../../docs/intents/', import.meta.url));
const pageNames = (files: { [file: string]: string }): string[] =>
  Object.keys(files).filter((name) => name.startsWith('rules/') && name.endsWith('.md'));

test('every generated non-JSON file of the real catalogue stays within the line ceiling', () => {
  for (const [name, data] of Object.entries(generatedFiles())) {
    if (name.endsWith('.json')) continue;
    expect(lineCount(data), name).toBeLessThanOrEqual(MAX_GENERATED_LINES);
  }
});

test('the workflow data asset carries every rule the page placeholders ask for', () => {
  const files = generatedFiles();
  for (const { name } of buildCatalogue().entries) {
    expect(files['index-workflows.js'], name).toContain(`  "${name}": `);
    expect(files['index.html'], name).toContain(`data-workflow="${name}"`);
  }
});

test('Markdown escaping writes each entity once and leaves quotes literal', () => {
  expect(escapeMarkdown(`what's "a" #1 (a_b) & <c>`)).toBe(`what's "a" &#35;1 &#40;a&#95;b&#41; &amp; &lt;c&gt;`);
  for (const [name, data] of Object.entries(generatedFiles()))
    if (name.endsWith('.md')) expect(data, name).not.toContain('&&#');
});

test('the workflow data asset never lets `<` or a line separator reach the script text', () => {
  const data = generatedFiles()['index-workflows.js']!;
  expect(data).not.toMatch(/<|\u2028|\u2029/);
});

test('every rule is described exactly once across the rule pages, and the README links each page', () => {
  const files = generatedFiles();
  const anchors = pageNames(files).flatMap((name) =>
    [...files[name]!.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]!),
  );
  const expected = buildCatalogue().entries.map((e) => e.name);
  expect([...anchors].sort()).toEqual([...expected].sort());
  for (const name of pageNames(files)) expect(files['README.md']).toContain(`(${name}#`);
});

test('generation is byte-deterministic', () => {
  expect(generatedFiles()).toEqual(generatedFiles());
});

test('checked-in rule pages match the generator exactly, with no leftovers', () => {
  const files = generatedFiles();
  const onDisk = readdirSync(join(docsDirectory, 'rules')).map((n) => `rules/${n}`);
  expect(onDisk.sort()).toEqual(
    Object.keys(files)
      .filter((n) => n.startsWith('rules/'))
      .sort(),
  );
});

test('--check fails when a rule page is tampered, missing, or an extra page exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-layout-'));
  try {
    const files = generatedFiles();
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), data);
    }
    expect(() => checkGeneratedFiles(dir)).not.toThrow();
    const page = pageNames(files)[0]!;
    writeFileSync(join(dir, page), `${files[page]}tampered`);
    expect(() => checkGeneratedFiles(dir)).toThrow('stale');
    writeFileSync(join(dir, page), files[page]!);
    writeFileSync(join(dir, 'rules/orphan.md'), 'x');
    expect(() => checkGeneratedFiles(dir)).toThrow('unexpected');
    rmSync(join(dir, 'rules/orphan.md'));
    rmSync(join(dir, page));
    expect(() => checkGeneratedFiles(dir)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function relativeTargets(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1]!)
    .filter((t) => !/^(?:[a-z]+:|#)/i.test(t))
    .map((t) => t.split('#')[0]!)
    .filter(Boolean);
}

test('every relative link in every rule page and the entry points resolves', () => {
  const pages = readdirSync(join(docsDirectory, 'rules')).map((n) => join(docsDirectory, 'rules', n));
  for (const file of [...pages, join(docsDirectory, 'index.html'), join(docsDirectory, 'README.md')])
    for (const target of relativeTargets(file))
      expect(existsSync(resolve(dirname(file), target)), `${file} -> ${target}`).toBe(true);
});
