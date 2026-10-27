import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePhraseSet } from '../../scripts/generate-call-phrases.ts';

describe('generatePhraseSet', () => {
  let root: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hcb-call-phrases-'));
    logs = [];
    errors = [];
    spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
    spyOn(console, 'error').mockImplementation((line: string) => {
      errors.push(line);
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    mock.restore();
  });

  test('writes each missing phrase, creating the target directory', async () => {
    const dir = join(root, 'nested', 'ru');
    const spoken: string[] = [];
    await generatePhraseSet('RU', dir, { 'a.ogg': 'Один', 'b.ogg': 'Два' }, async (text) => {
      spoken.push(text);
      return Buffer.from(`audio:${text}`);
    });
    expect(spoken).toEqual(['Один', 'Два']);
    expect(readFileSync(join(dir, 'a.ogg'), 'utf8')).toBe('audio:Один');
    expect(readFileSync(join(dir, 'b.ogg'), 'utf8')).toBe('audio:Два');
    expect(logs).toContain(`RU: ${dir}/a.ogg — "Один"`);
    expect(logs).toContain(`  OK (${Buffer.byteLength('audio:Один')} bytes)`);
  });

  test('is idempotent: an existing file is skipped and never re-synthesized', async () => {
    writeFileSync(join(root, 'a.ogg'), 'old');
    const spoken: string[] = [];
    await generatePhraseSet('EN', root, { 'a.ogg': 'One', 'b.ogg': 'Two' }, async (text) => {
      spoken.push(text);
      return Buffer.from('new');
    });
    expect(spoken).toEqual(['Two']);
    expect(readFileSync(join(root, 'a.ogg'), 'utf8')).toBe('old');
    expect(logs).toContain(`Skip: ${root}/a.ogg`);
  });

  test('a phrase that fails is reported and leaves no file; the others are still generated', async () => {
    await generatePhraseSet('EN', root, { 'a.ogg': 'One', 'b.ogg': 'Two' }, async (text) => {
      if (text === 'One') throw new Error('engine down');
      return Buffer.from('ok');
    });
    expect(existsSync(join(root, 'a.ogg'))).toBe(false);
    expect(readFileSync(join(root, 'b.ogg'), 'utf8')).toBe('ok');
    expect(errors).toEqual(['  FAIL: Error: engine down']);
  });

  test('a failure while preparing the text (synchronous throw) is also a per-phrase failure', async () => {
    await generatePhraseSet('RU', root, { 'a.ogg': 'One' }, () => {
      throw new Error('stress dictionary broken');
    });
    expect(existsSync(join(root, 'a.ogg'))).toBe(false);
    expect(errors).toEqual(['  FAIL: Error: stress dictionary broken']);
  });
});
