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
  renderHtml,
  renderMarkdown,
} from '../../../scripts/generate-intent-docs.ts';
import { renderMarkdownFiles } from '../../../scripts/intent-doc-markdown.ts';
import { escapeHtml, escapeMarkdown, lineCount } from '../../../scripts/intent-doc-text.ts';
import { renderWorkflowPages } from '../../../scripts/intent-doc-workflows.ts';

const docsDirectory = fileURLToPath(new URL('../../../docs/intents/', import.meta.url));
const pageNames = (files: { [file: string]: string }): string[] =>
  Object.keys(files).filter((name) => name.startsWith('rules/') && name.endsWith('.md'));

test('every generated non-JSON file of the real catalogue stays within the line ceiling', () => {
  for (const [name, data] of Object.entries(generatedFiles())) {
    if (name.endsWith('.json')) continue;
    expect(lineCount(data), name).toBeLessThanOrEqual(MAX_GENERATED_LINES);
  }
});

test('workflow pages preserve every complete pretty HTML block and the catalogue links each one', () => {
  const files = generatedFiles();
  const pages = Object.entries(files).filter(([name]) => name.startsWith('workflows/'));
  const c = buildCatalogue();
  const completeHtml = renderHtml(c);
  const completeMarkdown = renderMarkdown(c);
  expect(completeHtml).toContain('<style>');
  expect(completeHtml).toContain('<script>');
  expect(completeHtml).not.toMatch(/<(?:link|script)[^>]+(?:src|href)=["']/);
  for (const entry of c.entries) {
    const originalBlock = `<pre>${escapeHtml(JSON.stringify(entry.workflow, null, 2))}</pre>`;
    const matching = pages.filter(([, text]) => text.includes(`<section id="${entry.name}">`));
    expect(matching, entry.name).toHaveLength(1);
    const [name, text] = matching[0]!;
    expect(text, entry.name).toContain(originalBlock);
    expect(completeHtml, entry.name).toContain(originalBlock);
    expect(completeMarkdown, entry.name).toContain(JSON.stringify(entry.workflow, null, 2));
    expect(completeMarkdown, entry.name).toContain(`<a id="${entry.name}"></a>`);
    expect(files['index.html'], entry.name).toContain(`href="${name}#${entry.name}"`);
  }
  for (const [name, text] of pages) {
    expect(lineCount(text), name).toBeLessThanOrEqual(MAX_GENERATED_LINES);
    expect(text, name).not.toContain('<script');
  }
  expect(files).not.toHaveProperty('index-workflows.js');
});

test('Markdown escaping preserves the original document entity spelling', () => {
  expect(escapeMarkdown(`what's "a" #1 (a_b) & <c>`)).toBe(
    `what&&#35;39;s &quot;a&quot; &#35;1 &#40;a&#95;b&#41; &amp; &lt;c&gt;`,
  );
});

test('split Markdown pages escape authored text instead of interpreting markup', () => {
  const c = buildCatalogue();
  c.entries[0]!.examples = ['<script>alert(1)</script>', '[click](javascript:alert(1))', '```', '| a | b |'];
  c.entries[0]!.notes = '<img src=x onerror=alert(1)>';
  const md = Object.values(renderMarkdownFiles(c)).join('\n');
  expect(md).toContain('&lt;script&gt;');
  expect(md).not.toContain('<img src=x');
  expect(md).not.toContain('[click](javascript:alert(1))');
  expect(md).not.toContain('\n- | a | b |');
});

test('workflow pages escape authored JSON text without making it executable markup', () => {
  const c = buildCatalogue();
  c.entries[0]!.workflow = {
    ...c.entries[0]!.workflow,
    i18n: { ru: { unsafe: '<script>alert(1)</script> & \u2028 \u2029' }, en: {} },
  };
  const pages = Object.values(renderWorkflowPages(c)).join('\n');
  expect(pages).not.toContain('<script>alert(1)</script>');
  expect(pages).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp;');
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
  const pages = ['rules', 'workflows'].flatMap((folder) =>
    readdirSync(join(docsDirectory, folder)).map((name) => join(docsDirectory, folder, name)),
  );
  for (const file of [...pages, join(docsDirectory, 'index.html'), join(docsDirectory, 'README.md')])
    for (const target of relativeTargets(file))
      expect(existsSync(resolve(dirname(file), target)), `${file} -> ${target}`).toBe(true);
});
