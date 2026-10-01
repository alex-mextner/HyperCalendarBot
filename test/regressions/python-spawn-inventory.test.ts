// Every Python process the bot can launch — at startup or later — is named by a `scripts/*.py`
// literal in src/, so the inventory of those literals is the set of programs the bot can run.
// Two tiers exist (#753): the user's own Telegram session (connect/send on the user's behalf) and
// the shared service account, whose scripts only look people up, list members, read birthdays and
// place voice calls. The service account never sends a message, and only service-tier.ts names
// its scripts, so no caller can bypass the fail-closed gate.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { SERVICE_SCRIPTS } from '../../src/services/telegram-session/service-tier.ts';

const ROOT = join(import.meta.dir, '../..');
const SERVICE_TIER_MODULE = 'src/services/telegram-session/service-tier.ts';
const USER_SESSION_SCRIPTS = ['scripts/connect-session.py', 'scripts/send-as-user.py'];
const TTS_SCRIPTS = ['scripts/silero-tts.py'];

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

function inventory(): Map<string, Set<string>> {
  const namedBy = new Map<string, Set<string>>();
  for (const file of new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT, absolute: true })) {
    for (const script of pythonScriptsNamedIn(file)) {
      const files = namedBy.get(script) ?? new Set<string>();
      files.add(relative(ROOT, file));
      namedBy.set(script, files);
    }
  }
  return namedBy;
}

// Parsing every src file with the TypeScript compiler takes seconds on a loaded machine.
const INVENTORY_TIMEOUT_MS = 30_000;

test(
  'the bot can launch only the per-user session scripts, the service-tier scripts and the Silero TTS helper',
  () => {
    const serviceScripts = Object.values(SERVICE_SCRIPTS);
    const named = [...inventory().keys()].sort();
    expect(named).toEqual([...USER_SESSION_SCRIPTS, ...TTS_SCRIPTS, ...serviceScripts].sort());
    for (const script of named) expect(existsSync(join(ROOT, script))).toBe(true);
  },
  INVENTORY_TIMEOUT_MS,
);

test(
  'only the service-tier module names a service script, so every spawn passes its gate',
  () => {
    const namedBy = inventory();
    for (const script of Object.values(SERVICE_SCRIPTS)) {
      expect({ script, files: [...(namedBy.get(script) ?? [])] }).toEqual({ script, files: [SERVICE_TIER_MODULE] });
    }
  },
  INVENTORY_TIMEOUT_MS,
);

test('the service account has no script that sends a message', () => {
  expect(existsSync(join(ROOT, 'scripts/send-message.py'))).toBe(false);
  for (const script of Object.values(SERVICE_SCRIPTS)) {
    const source = readFileSync(join(ROOT, script), 'utf8');
    expect({ script, sends: source.match(/\.(send_\w+|forward_messages|copy_message)\(/g) ?? [] }).toEqual({
      script,
      sends: [],
    });
  }
});
