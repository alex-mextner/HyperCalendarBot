/**
 * Deterministic source SSG for the canonical intent basis. It reads only the current seed, its metadata
 * and the lineage table; it never opens a database and never imports the mutating seeder.
 *
 * The catalogue model lives in intent-doc-catalogue.ts, the renderers in intent-doc-markdown.ts and
 * intent-doc-html.ts. This module wires them into the file set under docs/intents and keeps that set fresh.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildCatalogue, type CatalogueSource, currentSource, DOCS_DIRECTORY } from './intent-doc-catalogue.ts';
import { readEngineMarkdown, renderHtml, renderHtmlAssets } from './intent-doc-html.ts';
import { RULES_DIRECTORY, renderMarkdown, renderMarkdownFiles } from './intent-doc-markdown.ts';
import { lineCount } from './intent-doc-text.ts';

export {
  buildCatalogue,
  type Catalogue,
  type CatalogueEntry,
  type CatalogueSource,
  currentSource,
  type DatabaseLineage,
  readDatabaseLineage,
} from './intent-doc-catalogue.ts';
export { renderHtml, renderMarkdown };

/** Policy ceiling for any generated text file (JSON is exempt); the layout aims well below it. */
export const MAX_GENERATED_LINES = 1200;

/** Generated files keyed by path relative to docs/intents. */
export interface GeneratedFiles {
  [file: string]: string;
}

function assertWithinLineCeiling(files: GeneratedFiles): void {
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith('.json')) continue;
    const lines = lineCount(data);
    if (lines > MAX_GENERATED_LINES)
      throw new Error(`Generated ${name} has ${lines} lines, over the ${MAX_GENERATED_LINES}-line ceiling`);
  }
}

export function generatedFiles(
  source: CatalogueSource = currentSource(),
  engine: string = readEngineMarkdown(),
): GeneratedFiles {
  const c = buildCatalogue(source);
  const files: GeneratedFiles = {
    ...renderMarkdownFiles(c),
    'index.html': renderHtml(c, engine),
    ...renderHtmlAssets(c),
    'catalogue.json': `${JSON.stringify(c, null, 2)}\n`,
  };
  assertWithinLineCeiling(files);
  return files;
}

/** Regular .md files left in the generated rules/ directory that the current catalogue no longer produces. */
function leftoverRuleFiles(directory: string, files: GeneratedFiles): string[] {
  const rules = resolve(directory, RULES_DIRECTORY);
  if (!existsSync(rules)) return [];
  return readdirSync(rules, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `${RULES_DIRECTORY}/${entry.name}`)
    .filter((path) => !(path in files));
}

export function checkGeneratedFiles(directory: string): void {
  const files = generatedFiles();
  for (const [name, data] of Object.entries(files)) {
    if (readFileSync(resolve(directory, name), 'utf8') !== data)
      throw new Error(`Generated docs stale: ${name}; run bun run docs:intents`);
  }
  const [leftover] = leftoverRuleFiles(directory, files);
  if (leftover) throw new Error(`Generated docs stale: unexpected ${leftover}; run bun run docs:intents`);
}

function writeGeneratedFiles(directory: string): number {
  const files = generatedFiles();
  for (const [name, data] of Object.entries(files)) {
    const path = resolve(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  }
  for (const leftover of leftoverRuleFiles(directory, files)) rmSync(resolve(directory, leftover));
  return Object.keys(files).length;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((x) => x !== '--check')) throw new Error('Usage: bun run docs:intents [--check]');
  if (args.includes('--check')) {
    checkGeneratedFiles(DOCS_DIRECTORY);
    console.log('Intent SSG is current');
  } else {
    console.log(`Generated docs/intents: ${writeGeneratedFiles(DOCS_DIRECTORY)} files (Markdown, HTML, CSS, JS, JSON)`);
  }
}
