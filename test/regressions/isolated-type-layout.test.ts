import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

test('configured compiler follows transitive ambient types in an isolated dependency store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-type-layout-'));
  try {
    const typePackage = join(dir, '.store/types/node_modules/@types/proof');
    const transitive = join(dir, '.store/types/node_modules/proof-transitive');
    mkdirSync(typePackage, { recursive: true });
    mkdirSync(transitive, { recursive: true });
    mkdirSync(join(dir, 'node_modules/@types'), { recursive: true });
    writeFileSync(join(typePackage, 'index.d.ts'), '/// <reference types="proof-transitive" />\nexport {};\n');
    writeFileSync(join(typePackage, 'package.json'), '{"name":"@types/proof","types":"index.d.ts"}');
    writeFileSync(join(transitive, 'index.d.ts'), 'declare function relocatedApi(value: string): number;\n');
    writeFileSync(join(transitive, 'package.json'), '{"name":"proof-transitive","types":"index.d.ts"}');
    symlinkSync(typePackage, join(dir, 'node_modules/@types/proof'), 'dir');
    const fixture = join(dir, 'entry.ts');
    writeFileSync(fixture, 'const result = relocatedApi("input"); export { result };\n');
    const root = resolve(import.meta.dir, '../..');
    const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
    expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    expect(parsed.errors).toEqual([]);
    const options = { ...parsed.options, types: ['proof'], typeRoots: [join(dir, 'node_modules/@types')] };
    const host = ts.createCompilerHost(options);
    host.getCurrentDirectory = () => dir;
    const program = ts.createProgram([fixture], options, host);
    const source = program.getSourceFile(fixture)!;
    const errors = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(errors).toEqual([]);
    const declaration = source.statements.filter(ts.isVariableStatement)[0]!.declarationList.declarations[0]!;
    const type = program.getTypeChecker().getTypeAtLocation(declaration.name);
    expect(type.flags & ts.TypeFlags.Any).toBe(0);
    expect(type.flags & ts.TypeFlags.Number).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
