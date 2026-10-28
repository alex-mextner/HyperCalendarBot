import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Every call to the plain identifier `callee` in the source file at `relativePath`. */
function callsTo(relativePath: string, callee: string): { source: ts.SourceFile; calls: ts.CallExpression[] } {
  const path = new URL(relativePath, import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee)
      calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { source, calls };
}

test('startup calls the notification bootstrap instead of wiring the worker itself', () => {
  expect(callsTo('../../src/index.ts', 'initNotificationScheduler').calls).toHaveLength(1);
  expect(callsTo('../../src/index.ts', 'createNotificationWorker').calls).toHaveLength(0);
});

test('bootstrap binds the tested sender directly, without a rejection-swallowing wrapper', () => {
  const { source, calls } = callsTo('../../src/bootstrap/notifications.ts', 'createNotificationWorker');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.arguments[2]?.getText(source)).toBe('createNotificationSender(botRef)');
});
