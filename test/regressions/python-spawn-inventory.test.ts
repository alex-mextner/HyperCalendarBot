// The shared MTProto service account (data/voice_caller.session) was removed on 2026-09-29.
// Every Python process the bot can launch — at startup or later — is named by a `scripts/*.py`
// literal in src/, so the inventory of those literals is the set of programs the bot can run.
// Only the user's own Telegram session scripts and the Silero TTS helper may remain.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '../..');

function pythonScriptsNamedIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^scripts\/[\w.-]+\.py$/.test(node.text)
    )
      found.push(node.text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

test('the bot can launch only the per-user Telegram scripts and the Silero TTS helper', () => {
  const named = new Set<string>();
  for (const file of new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT, absolute: true })) {
    for (const script of pythonScriptsNamedIn(file)) named.add(script);
  }

  expect([...named].sort()).toEqual(['scripts/connect-session.py', 'scripts/send-as-user.py', 'scripts/silero-tts.py']);
  for (const script of named) expect(existsSync(join(ROOT, script))).toBe(true);
});
