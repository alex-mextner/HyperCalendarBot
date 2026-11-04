import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStressDictionary } from '../../src/bootstrap/speech.ts';
import { StressDictionary } from '../../src/services/voice/stress-dictionary.ts';
import { voiceLogger } from '../../src/services/voice/types.ts';
import { botLogger } from '../../src/utils/logger.ts';

describe('loadStressDictionary at startup', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hcb-speech-'));
    path = join(dir, 'stress-dict.json');
    writeFileSync(path, JSON.stringify({ молоко: 'молок+о' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('registers an existing file without reading its entries', async () => {
    const dictionary = await loadStressDictionary(path);
    // A startup that parsed the file would hold this entry; the real one holds 555K and costs about 80 MB.
    writeFileSync(path, JSON.stringify({ календарь: 'календ+арь' }));

    expect(dictionary).toBeInstanceOf(StressDictionary);
    expect(dictionary?.size).toBe(0);
    expect(await dictionary?.ensureLoaded()).toBe(true);
    expect(dictionary?.lookup('календарь')).toBe('календ+арь');
    expect(dictionary?.lookup('молоко')).toBeNull();
  });

  test('a missing file leaves the dictionary absent and logs the warning startup always logged', async () => {
    const warn = spyOn(botLogger, 'warn').mockImplementation(() => {});
    try {
      const dictionary = await loadStressDictionary(join(dir, 'absent.json'));

      expect(dictionary).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe('Stress dictionary not loaded');
    } finally {
      warn.mockRestore();
    }
  });

  test('with Silero configured the file is read at startup, as it always was', async () => {
    const dictionary = await loadStressDictionary(path, true);
    // Changed after startup: only an eager read would hold the original entry already.
    writeFileSync(path, JSON.stringify({ календарь: 'календ+арь' }));

    expect(dictionary?.size).toBe(1);
    expect(await dictionary?.ensureLoaded()).toBe(true);
    expect(dictionary?.lookup('молоко')).toBe('молок+о');
    expect(dictionary?.lookup('календарь')).toBeNull();
  });

  test('with Silero configured a file that cannot be parsed leaves no dictionary, so Silero stays off', async () => {
    const warn = spyOn(voiceLogger, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(path, '{ not json');

      expect(await loadStressDictionary(path, true)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe('Stress dictionary not loaded');
    } finally {
      warn.mockRestore();
    }
  });
});
