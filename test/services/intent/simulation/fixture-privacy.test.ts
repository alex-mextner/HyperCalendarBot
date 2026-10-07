// Committed fixtures must be written from scratch. When the private corpus is present on this
// machine (never in CI), no fixture string may equal or nearly equal a private request.
// Paths: INTENT_PRIVATE_CORPUS (colon-separated) or the default private locations under logs/.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixtureStrings, privateRequestStrings } from '../../../../src/services/intent/simulation/corpus.ts';
import { nearDuplicates, normalizedEditDistance } from '../../../../src/services/intent/simulation/similarity.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const FIXTURES = join(REPO, 'test/fixtures/intent-corpus/synthetic-cases.json');
const privatePaths = (
  process.env.INTENT_PRIVATE_CORPUS?.split(':') ?? [
    join(REPO, 'logs/canonical-basis-20260919/private-corpus.json'),
    join(REPO, 'logs/intent-learning-20260919/semantic-cases.json'),
  ]
).filter((path) => path && existsSync(path));

describe('normalized edit distance', () => {
  test('ignores case, punctuation and repeated spaces', () => {
    expect(normalizedEditDistance('Что у меня  сегодня?', 'что у меня сегодня')).toBe(0);
  });

  test('scores a one-word edit of a short sentence as near', () => {
    expect(normalizedEditDistance('move the dentist to friday', 'move the dentist to monday')).toBeLessThan(0.3);
  });

  test('scores unrelated sentences as far', () => {
    expect(normalizedEditDistance('show my contacts', 'remind me about the rent')).toBeGreaterThanOrEqual(0.3);
  });

  test('never compares strings without letters or digits', () => {
    expect(nearDuplicates(['../..', 'show my contacts'], ['!!!', '🙂'], 0.3)).toEqual([]);
  });

  test('reports each near pair once with both sides', () => {
    expect(nearDuplicates(['what is next', 'totally different text'], ['What is next?'], 0.3)).toEqual([
      { fixture: 'what is next', source: 'What is next?' },
    ]);
  });
});

test('every fixture string is marked synthetic in the file itself', () => {
  const raw = readFileSync(FIXTURES, 'utf8');
  expect(fixtureStrings(FIXTURES).length).toBeGreaterThan(60);
  expect(raw).not.toMatch(/"origin":\s*"(?!synthetic")/);
});

test.skipIf(privatePaths.length === 0)('no fixture string equals or nearly equals a private request', () => {
  const sources = privatePaths.flatMap((path) => privateRequestStrings(path));
  expect(sources.length).toBeGreaterThan(0);
  expect(nearDuplicates(fixtureStrings(FIXTURES), sources, 0.3)).toEqual([]);
});
