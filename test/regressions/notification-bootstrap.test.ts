import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('bootstrap binds the tested sender directly, without a rejection-swallowing wrapper', () => {
  const path = new URL('../../src/index.ts', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const matches: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createNotificationWorker'
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(matches).toHaveLength(1);
  expect(matches[0]?.arguments[2]?.getText(source)).toBe('createNotificationSender(botRef)');
});
