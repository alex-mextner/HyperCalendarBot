// Keep the inert fixture reachable to dependency analysis; it never calls fetch.
import '../fixtures/fetch-types.ts';
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';

test('Fetch declarations resolve through the configured dependency layout', () => {
  const root = resolve(import.meta.dir, '../..');
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  const fixturePath = resolve(root, 'test/fixtures/fetch-types.ts');
  const program = ts.createProgram([fixturePath], parsed.options);
  const source = program.getSourceFile(fixturePath);
  if (!source) throw new Error(`Compiler did not load the fixture: ${fixturePath}`);
  expect(program.getOptionsDiagnostics()).toEqual([]);
  const checker = program.getTypeChecker();
  const declarations = source.statements.filter(ts.isFunctionDeclaration);
  const functionBody = declarations.find((node) => node.name?.text === 'checkFetchTypes')?.body;
  if (!functionBody) throw new Error('Fetch fixture function missing');
  const responseStatement = functionBody.statements
    .filter(ts.isVariableStatement)
    .flatMap((node) => [...node.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === 'response');
  if (!responseStatement) throw new Error('Fetch fixture response missing');
  const responseType = checker.getTypeAtLocation(responseStatement.name);
  expect(responseType.flags & ts.TypeFlags.Any).toBe(0);
  for (const property of ['ok', 'status', 'text', 'headers']) expect(responseType.getProperty(property)).toBeDefined();
  const diagnostics = program.getSemanticDiagnostics(source);
  const errors = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  expect(errors).toEqual([]);
}, 30_000);
