import '../fixtures/fetch-types.ts';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';

test('Fetch declarations resolve through the configured dependency layout', () => {
  const root = resolve(import.meta.dir, '../..');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const path = resolve(root, 'test/fixtures/fetch-types.ts');
  const program = ts.createProgram([path], parsed.options);
  const source = program.getSourceFile(path);
  expect(source).toBeDefined();
  const diagnostics = program.getSemanticDiagnostics(source);
  const errors = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  expect(errors).toEqual([]);
}, 30_000);
