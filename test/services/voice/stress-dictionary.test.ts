import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';
import { voiceLogger } from '../../../src/services/voice/types.ts';

describe('StressDictionary', () => {
  const dict = new StressDictionary({
    молоко: 'молок+о',
    молока: 'молок+а',
    молоком: 'молок+ом',
    встреча: 'встр+еча',
    встречу: 'встр+ечу',
    календарь: 'календ+арь',
    человек: 'челов+ек',
  });

  test('looks up known words', () => {
    expect(dict.lookup('молоко')).toBe('молок+о');
    expect(dict.lookup('встреча')).toBe('встр+еча');
  });

  test('is case-insensitive', () => {
    expect(dict.lookup('Молоко')).toBe('молок+о');
    expect(dict.lookup('ВСТРЕЧА')).toBe('встр+еча');
  });

  test('returns null for unknown words', () => {
    expect(dict.lookup('алексом')).toBeNull();
    expect(dict.lookup('xyz')).toBeNull();
  });

  test('lookupMany returns stressed and similar for each word', () => {
    const results = dict.lookupMany(['молоко', 'алексом', 'встреча']);
    expect(results.молоко!.stressed).toBe('молок+о');
    expect(results.молоко!.similar).toEqual([]);
    expect(results.встреча!.stressed).toBe('встр+еча');
    expect(results.алексом!.stressed).toBeNull();
  });

  test('findSimilar returns words with shared prefix', () => {
    const similar = dict.findSimilar('молоки', 5);
    expect(similar.length).toBeGreaterThan(0);
    expect(similar.some((s) => s.includes('молок'))).toBe(true);
  });

  test('findSimilar returns empty for very short words', () => {
    const similar = dict.findSimilar('мо', 5);
    expect(similar).toEqual([]);
  });

  test('lookupMany includes similar when word not found', () => {
    const results = dict.lookupMany(['молоки']);
    expect(results.молоки!.stressed).toBeNull();
    expect(results.молоки!.similar.length).toBeGreaterThan(0);
  });

  test('reports correct size', () => {
    expect(dict.size).toBe(7);
  });
});

describe('StressDictionary loaded on first use', () => {
  const WORDS: Record<string, string> = {
    молоко: 'молок+о',
    молока: 'молок+а',
    молоком: 'молок+ом',
    встреча: 'встр+еча',
  };
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hcb-stress-'));
    path = join(dir, 'stress-dict.json');
    writeFileSync(path, JSON.stringify(WORDS));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('registering the file reads nothing: what is loaded is what the file holds at the first ensureLoaded', async () => {
    const dict = await StressDictionary.lazyFromFile(path);
    // Changed after registration. An eager read at registration would have kept the old entries.
    writeFileSync(path, JSON.stringify({ календарь: 'календ+арь' }));

    expect(dict.size).toBe(0);
    expect(await dict.ensureLoaded()).toBe(true);

    expect(dict.lookup('календарь')).toBe('календ+арь');
    expect(dict.lookup('молоко')).toBeNull();
    expect(dict.size).toBe(1);
  });

  test('answering before the first load throws instead of reporting every word as unknown', async () => {
    const dict = await StressDictionary.lazyFromFile(path);

    expect(() => dict.lookup('молоко')).toThrow(/ensureLoaded/);
    expect(() => dict.lookupMany(['молоко'])).toThrow(/ensureLoaded/);
    expect(() => dict.findSimilar('молоки', 5)).toThrow(/ensureLoaded/);
  });

  test('after the load it answers exactly like the eager dictionary', async () => {
    const eager = new StressDictionary(WORDS);
    const lazy = await StressDictionary.lazyFromFile(path);
    await lazy.ensureLoaded();

    expect(lazy.size).toBe(eager.size);
    expect(lazy.lookup('Молоко')).toBe(eager.lookup('Молоко'));
    expect(lazy.lookupMany(['молоко', 'молоки', 'алексом'])).toEqual(eager.lookupMany(['молоко', 'молоки', 'алексом']));
    expect(lazy.findSimilar('молоки', 5)).toEqual(eager.findSimilar('молоки', 5));
  });

  test('concurrent callers share one load and later callers get the same answer', async () => {
    const dict = await StressDictionary.lazyFromFile(path);
    const first = dict.ensureLoaded();
    const second = dict.ensureLoaded();

    expect(second).toBe(first);
    expect(await first).toBe(true);
    writeFileSync(path, JSON.stringify({}));
    expect(await dict.ensureLoaded()).toBe(true);
    expect(dict.size).toBe(Object.keys(WORDS).length);
  });

  test('an eager dictionary is ready without a load', async () => {
    const dict = new StressDictionary(WORDS);

    expect(await dict.ensureLoaded()).toBe(true);
    expect(dict.lookup('молоко')).toBe('молок+о');
  });

  test('a missing file is refused at registration, as the eager read was at startup', async () => {
    await expect(StressDictionary.lazyFromFile(join(dir, 'absent.json'))).rejects.toThrow(/not found/);
  });

  test('a file that cannot be parsed logs once, finds nothing and is not read again', async () => {
    const warn = spyOn(voiceLogger, 'warn').mockImplementation(() => {});
    try {
      const dict = await StressDictionary.lazyFromFile(path);
      writeFileSync(path, '{ not json');

      expect(await dict.ensureLoaded()).toBe(false);
      expect(dict.lookup('молоко')).toBeNull();
      expect(dict.findSimilar('молоки', 5)).toEqual([]);

      writeFileSync(path, JSON.stringify(WORDS));
      expect(await dict.ensureLoaded()).toBe(false);
      expect(dict.lookup('молоко')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe('Stress dictionary not loaded');
    } finally {
      warn.mockRestore();
    }
  });

  test('a file whose values are not strings is refused like a parse failure', async () => {
    const warn = spyOn(voiceLogger, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(path, JSON.stringify({ молоко: 5 }));
      const dict = await StressDictionary.lazyFromFile(path);

      expect(await dict.ensureLoaded()).toBe(false);
      expect(dict.lookup('молоко')).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
