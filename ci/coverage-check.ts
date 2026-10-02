// Validates LCOV and inventories bot sources without executing uninstrumented modules.
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export function runtimeSourceLines(source: string, fileName: string): Set<number> {
  // Declaration files cannot emit JavaScript. Parsing them also catches malformed syntax.
  const input = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true);
  const result = ts.transpileModule(source, {
    fileName: input.isDeclarationFile ? 'declarations.ts' : fileName,
    reportDiagnostics: true,
    compilerOptions: {
      sourceMap: true,
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.Preserve,
      verbatimModuleSyntax: true,
      jsx: ts.JsxEmit.ReactJSX,
      moduleDetection: ts.ModuleDetectionKind.Force,
    },
  });
  if (result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
    throw new Error(`Cannot classify invalid source: ${fileName}`);
  const emitted = ts.createSourceFile('emitted.js', result.outputText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const runtime = emitted.statements.some(
    (statement) =>
      !(
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length === 0
      ),
  );
  if (!runtime) return new Set();
  if (!result.sourceMapText) throw new Error(`Missing compiler source map: ${fileName}`);
  const map: { mappings: string } = JSON.parse(result.sourceMapText);
  const lines = mappedSourceLines(map.mappings);
  if (!lines.size) throw new Error(`No runtime source mappings: ${fileName}`);
  return lines;
}

// Source-map segments encode generated column, source index, original line/column,
// and optionally name as signed VLQ deltas. Original line state spans segments/rows.
function mappedSourceLines(mappings: string): Set<number> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lines = new Set<number>();
  let originalLine = 0;
  for (const segment of mappings.split(/[;,]/)) {
    if (!segment) continue;
    const fields: number[] = [];
    let value = 0;
    let shift = 0;
    for (const char of segment) {
      const digit = alphabet.indexOf(char);
      if (digit < 0 || shift > 50) throw new Error('Invalid compiler source map VLQ');
      value += (digit & 31) * 2 ** shift;
      if (digit & 32) shift += 5;
      else {
        fields.push((value % 2 ? -1 : 1) * Math.floor(value / 2));
        value = shift = 0;
      }
    }
    if (shift || ![1, 4, 5].includes(fields.length)) throw new Error('Invalid compiler source map segment');
    const delta = fields[2];
    if (delta !== undefined) {
      originalLine += delta;
      if (!Number.isSafeInteger(originalLine) || originalLine < 0) throw new Error('Invalid compiler source line');
      lines.add(originalLine + 1);
    }
  }
  return lines;
}

export function hasRuntimeCode(source: string, fileName: string): boolean {
  return runtimeSourceLines(source, fileName).size > 0;
}

export function productionLineCoverage(lcov: string): {
  covered: number;
  total: number;
  ratio: number;
  instrumented: string[];
  files: Map<string, Map<number, boolean>>;
} {
  const files = new Map<string, Map<number, boolean>>();
  let current: Map<number, boolean> | undefined;
  let record: Map<number, boolean> | undefined;
  let found: number | undefined;
  let hit: number | undefined;
  for (const raw of lcov.split(/\r?\n/)) {
    if (raw.startsWith('SF:')) {
      if (record) throw new Error('Malformed unfinished coverage record');
      record = new Map();
      found = hit = undefined;
      const name = raw.slice(3).replaceAll('\\', '/');
      const localPath = relative(process.cwd(), resolve(name)).replaceAll('\\', '/');
      current = localPath.startsWith('src/') ? (files.get(localPath) ?? new Map<number, boolean>()) : undefined;
      if (current) files.set(localPath, current);
    } else if (raw.startsWith('DA:')) {
      if (!/^DA:[1-9]\d*,\d+(?:,[a-zA-Z0-9]+)?$/.test(raw)) throw new Error('Malformed coverage record');
      const parts = raw.slice(3).split(',');
      const line = Number(parts[0]);
      const hits = Number(parts[1]);
      if (!Number.isSafeInteger(line) || line <= 0 || !Number.isSafeInteger(hits) || hits < 0)
        throw new Error('Malformed coverage record');
      if (!record) throw new Error('Malformed orphan coverage line');
      record.set(line, !!record.get(line) || hits > 0);
      // LCOV merges repeated executions by union; each source line is counted once.
      current?.set(line, !!current.get(line) || hits > 0);
    } else if (/^(LF|LH):/.test(raw)) {
      if (!record || !/^(LF|LH):\d+$/.test(raw)) throw new Error('Malformed summary');
      if (raw.startsWith('LF:')) found = Number(raw.slice(3));
      else hit = Number(raw.slice(3));
    } else if (raw === 'end_of_record') {
      if (
        !record ||
        (found !== undefined && found !== record.size) ||
        (hit !== undefined && hit !== [...record.values()].filter(Boolean).length)
      )
        throw new Error('Malformed coverage summary');
      current = record = undefined;
    }
  }
  if (record) throw new Error('Malformed unfinished coverage record');
  let total = 0,
    covered = 0;
  for (const lines of files.values())
    for (const hit of lines.values()) {
      total++;
      if (hit) covered++;
    }
  if (!total) throw new Error('No production line coverage data');
  return {
    covered,
    total,
    ratio: covered / total,
    files,
    instrumented: [...files]
      .filter(([, lines]) => lines.size > 0)
      .map(([path]) => path)
      .sort(),
  };
}
// The CLI and regression tests share this evaluator, including the unrounded 80% decision.
export function evaluateCoverage(lcov: string, sources: ReadonlyMap<string, string>) {
  const { files, ...loaded } = productionLineCoverage(lcov);
  const sourceFiles = [...sources.keys()].sort();
  const unknown = [...files.keys()].filter((path) => !sources.has(path));
  if (unknown.length) throw new Error(`Coverage references nonexistent sources: ${unknown.join(', ')}`);
  const noRuntime: { path: string; physicalLines: number; executableLines: number }[] = [];
  const uninstrumented: { path: string; physicalLines: number }[] = [];
  const missingRuntime: { path: string; lines: number[] }[] = [];
  for (const path of sourceFiles) {
    const source = sources.get(path);
    if (source === undefined) throw new Error(`Missing inventoried source: ${path}`);
    const physicalLines = source
      ? source.split(/\r\n|[\n\r\u2028\u2029]/).length - Number(/[\n\r\u2028\u2029]$/.test(source))
      : 0;
    const reported = files.get(path);
    for (const line of reported?.keys() ?? [])
      if (line > physicalLines) throw new Error(`DA:${line} outside source line bounds (1..${physicalLines}): ${path}`);
    const runtimeLines = runtimeSourceLines(source, path);
    for (const line of runtimeLines)
      if (line > physicalLines) throw new Error(`Compiler mapping outside source line bounds: ${path}:${line}`);
    if (!reported?.size) {
      if (runtimeLines.size) uninstrumented.push({ path, physicalLines });
      else noRuntime.push({ path, physicalLines, executableLines: 0 });
    } else {
      const lines = [...runtimeLines].filter((line) => !reported.has(line)).sort((a, b) => a - b);
      if (lines.length) missingRuntime.push({ path, lines });
    }
  }
  const total =
    loaded.total +
    uninstrumented.reduce((sum, file) => sum + file.physicalLines, 0) +
    missingRuntime.reduce((sum, file) => sum + file.lines.length, 0);
  const conservative = { covered: loaded.covered, total, ratio: loaded.covered / total };
  return {
    scope:
      'Bot runtime src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}, including hidden paths and declarations. Separate packages, scripts, tests and CI tooling are outside this scope.',
    denominator:
      'Union of LCOV DA and compiler-mapped runtime source lines for loaded files, plus every physical line of uninstrumented runtime files; missing lines are uncovered. Report validation, not proof of execution or whole-repository coverage.',
    sourceFiles,
    loaded,
    missingRuntime,
    uninstrumented,
    noRuntime,
    compiler: {
      version: ts.version,
      module: 'Preserve',
      verbatimModuleSyntax: true,
      target: 'ESNext',
      jsx: 'ReactJSX',
      sourceMap: true,
      removeComments: true,
    },
    conservative,
    threshold: 0.8,
    passed: conservative.ratio >= 0.8,
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: bun ci/coverage-check.ts report.info [summary.json]');
  const sourceFiles = [
    ...new Bun.Glob('src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}').scanSync({ cwd: '.', dot: true }),
  ].sort();
  const sources = new Map<string, string>();
  for (const file of sourceFiles) sources.set(file, await Bun.file(file).text());
  const summary = evaluateCoverage(await Bun.file(path).text(), sources);
  const json = `${JSON.stringify(summary, null, 2)}\n`;
  if (process.argv[3]) await Bun.write(process.argv[3], json);
  console.log(json);
  if (!summary.passed) process.exitCode = 1;
}
