import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleLookupStress } from '../../../src/services/ai/tool-handlers/meta.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { StressDictionary } from '../../../src/services/voice/stress-dictionary.ts';
import { voiceLogger } from '../../../src/services/voice/types.ts';
import { partialOf } from './partial-stubs.ts';

describe('lookup_stress with a dictionary that loads on first use', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hcb-lookup-stress-'));
    path = join(dir, 'stress-dict.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function contextWith(dictionary: StressDictionary): AgentContext {
    return partialOf<AgentContext>('ctx', { voice: { stressDictionary: dictionary } });
  }

  test('the first call loads the file and answers from it', async () => {
    writeFileSync(path, JSON.stringify({ молоко: 'молок+о' }));
    const dictionary = await StressDictionary.lazyFromFile(path);
    expect(dictionary.size).toBe(0);

    const result = await handleLookupStress(contextWith(dictionary), { words: ['молоко'] });

    expect(result).toEqual({ success: true, output: 'молоко → молок+о' });
    expect(dictionary.size).toBe(1);
  });

  test('an unreadable file is reported as not loaded, never as every word missing', async () => {
    const warn = spyOn(voiceLogger, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(path, JSON.stringify({ молоко: 'молок+о' }));
      const dictionary = await StressDictionary.lazyFromFile(path);
      writeFileSync(path, '{ not json');

      const result = await handleLookupStress(contextWith(dictionary), { words: ['молоко'] });

      expect(result).toEqual({ success: false, error: 'Stress dictionary not loaded' });
    } finally {
      warn.mockRestore();
    }
  });

  test('without a dictionary the tool says so', async () => {
    const result = await handleLookupStress(partialOf<AgentContext>('ctx', { voice: undefined }), {
      words: ['молоко'],
    });

    expect(result).toEqual({ success: false, error: 'Stress dictionary not loaded' });
  });
});
