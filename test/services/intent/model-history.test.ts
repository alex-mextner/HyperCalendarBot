import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { loadHistory } from '../../../scripts/intent-benchmark/benchmark.ts';
import { build } from '../../../scripts/intent-benchmark/build-history.ts';
import { problemsOf } from '../../../scripts/intent-benchmark/validate-history.ts';

const DIRECTORY = new URL('../../../docs/intents/model-history/', import.meta.url);

describe('model history', () => {
  const history = loadHistory();
  const all = [...history.dev, ...history.heldout];

  test('is large enough and keeps a real held-out split', () => {
    expect(all.length).toBeGreaterThanOrEqual(600);
    expect(history.heldout.length / all.length).toBeGreaterThanOrEqual(0.3);
    expect(history.dev.length).toBeGreaterThan(history.heldout.length);
  });

  test('committed files are exactly what the authored sources build to', () => {
    for (const [name, body] of Object.entries(build().files))
      expect(readFileSync(new URL(name, DIRECTORY), 'utf8'), name).toBe(body);
  });

  test('every conversation is internally consistent', () => {
    for (const conversation of all) expect(problemsOf(conversation), conversation.id).toEqual([]);
  });

  test('no message appears twice, so a held-out message never repeats a dev one', () => {
    const seen = new Set<string>();
    for (const conversation of all) {
      const key = `${conversation.lang}|${conversation.say.toLowerCase()}`;
      expect(seen.has(key), conversation.say).toBe(false);
      seen.add(key);
    }
  });

  test('covers Russian and English, both chat kinds, every zone, and both route kinds', () => {
    expect(new Set(all.map((c) => c.lang))).toEqual(new Set(['ru', 'en']));
    expect(new Set(all.map((c) => c.chat))).toEqual(new Set(['private', 'group']));
    expect(new Set(all.map((c) => c.tz)).size).toBe(6);
    expect(all.some((c) => c.expect.route === 'ai')).toBe(true);
    expect(all.filter((c) => c.expect.route === 'rule').length).toBeGreaterThanOrEqual(400);
  });

  test('holds no real-looking personal data', () => {
    const text =
      readFileSync(new URL('conversations.dev.jsonl', DIRECTORY), 'utf8') +
      readFileSync(new URL('conversations.heldout.jsonl', DIRECTORY), 'utf8');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/\+?\d[\d\s().-]{9,}\d/);
    const handles = new Set([...text.matchAll(/@[A-Za-z0-9_]{5,32}/g)].map((m) => m[0]));
    expect([...handles].filter((h) => !['@ivan_petrov', '@anna_smith', '@mark_t1'].includes(h))).toEqual([]);
  });
});
