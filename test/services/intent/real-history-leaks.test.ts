// The committed real-history corpus holds scrubbed text only. The scrubber's entity registry is built from private
// databases and never leaves the odroid, so the entity-form gate is certified in manifest.json by the builder (and
// re-run on the committed file with `build_real_corpus.py --verify`); what a public test can prove is the format gate
// (no e-mail, URL, handle or phone outside the scrubber's placeholders), that the file is the one the manifest
// certifies, that no mapping travels with it, and that labels and split cover it exactly.

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { loadCorpus, loadLabels, loadRealHistory } from '../../../scripts/intent-benchmark/real-history.ts';

const DIR = new URL('../../../docs/intents/real-history/', import.meta.url);
const text = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_FORM = /\b(?:https?:\/\/|www\.|t\.me\/|tg:\/\/)[^\s<>"')\]]+/gi;
const HANDLE = /(?<![\w@])@[A-Za-z0-9_]{4,32}\b/g;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function* strings(value: Json): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* strings(item);
}

const everyString = (): string[] =>
  text('corpus.jsonl')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => [...strings(JSON.parse(line) as Json)]);

describe('real-history corpus: leak gates', () => {
  test('the file is the one the manifest certifies, and the certified gates are all zero', () => {
    const { manifest, checksum, records } = loadCorpus();
    expect(checksum).toBe(manifest.checksum);
    expect(manifest.records).toBe(records.length);
    expect(manifest.leakGates).toMatchObject({ passed: true, entityForms: 0, wholeEntityStrings: 0, regex: {} });
  });

  test('no e-mail, URL or handle survives except the scrubber placeholders', () => {
    const offenders: string[] = [];
    for (const value of everyString()) {
      for (const match of value.matchAll(EMAIL)) if (!match[0].endsWith('@example.org')) offenders.push(match[0]);
      for (const match of value.matchAll(URL_FORM)) if (!match[0].includes('example.org/')) offenders.push(match[0]);
      for (const match of value.matchAll(HANDLE)) if (!match[0].startsWith('@px_')) offenders.push(match[0]);
    }
    expect(offenders).toEqual([]);
  });

  test('no login code or password a user typed into the Telegram-connect wizard is kept', () => {
    const PROMPT =
      /(?:введи(?:те)?\s+(?:пароль|код)|пароль\s*\(|двухфакторн|код\s+подтверждения\s+отправлен|enter\s+(?:the\s+|your\s+)?(?:password|code)|two-factor|2fa|login\s+code)/i;
    const SPACED_CODE = /^\s*\d(?:[\s-]\d){3,7}\s*$/;
    const offenders: string[] = [];
    for (const line of text('corpus.jsonl').split('\n')) {
      if (line.trim().length === 0) continue;
      const record = z
        .object({ id: z.string(), history: z.array(z.object({ role: z.string(), text: z.string().nullish() })) })
        .parse(JSON.parse(line));
      let asking = false;
      for (const turn of record.history) {
        const turnText = turn.text ?? '';
        if (turn.role === 'assistant' && turnText) asking = PROMPT.test(turnText);
        else if (turn.role === 'user' && turnText && (asking || SPACED_CODE.test(turnText)))
          if (turnText !== '[REDACTED:credential]') offenders.push(record.id);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('user ids in the corpus are pseudonyms, not Telegram ids or names', () => {
    const { records } = loadCorpus();
    for (const record of records) expect(record.user).toMatch(/^u\d{2}$/);
    expect(new Set(records.map((record) => record.user)).size).toBeGreaterThan(20);
  });

  test('no mapping or key file is committed beside the corpus', () => {
    const names = readdirSync(DIR);
    expect(names.filter((name) => /mapping|secret|\.key$|\.env/i.test(name))).toEqual([]);
    expect(text('manifest.json')).not.toMatch(/"mapping"\s*:\s*\{/);
  });

  test('the scrubber unit tests pass on invented data', () => {
    const run = Bun.spawnSync(
      ['python3', '-m', 'unittest', 'discover', '-s', 'scripts/real-history', '-p', 'test_scrub.py'],
      {
        cwd: new URL('../../../', import.meta.url).pathname,
      },
    );
    expect(new TextDecoder().decode(run.stderr)).toContain('OK');
    expect(run.exitCode).toBe(0);
  });
});

describe('real-history labels and split', () => {
  const Split = z.object({ corpusChecksum: z.string(), dev: z.array(z.string()), heldout: z.array(z.string()) });

  test('every corpus record has exactly one label and no label is orphaned', () => {
    const { records } = loadCorpus();
    const { labels } = loadLabels();
    expect([...labels.keys()].sort()).toEqual(records.map((record) => record.id).sort());
  });

  test('the split is disjoint, covers every non-probe record and keeps at least 30% held out', () => {
    const { records, checksum } = loadCorpus();
    const split = Split.parse(JSON.parse(text('split.json')));
    expect(split.corpusChecksum).toBe(checksum);
    const devIds = new Set(split.dev);
    expect(split.heldout.filter((id) => devIds.has(id))).toEqual([]);
    const usable = records.filter((record) => !record.flags.qaProbe).map((record) => record.id);
    expect([...split.dev, ...split.heldout].sort()).toEqual(usable.sort());
    expect(split.heldout.length / usable.length).toBeGreaterThanOrEqual(0.3);
  });

  test('QA probes never enter a measured split', () => {
    const real = loadRealHistory();
    expect(real.excludedQaProbes).toBeGreaterThan(0);
    const ids = new Set([...real.dev, ...real.heldout].map((conversation) => conversation.id));
    for (const record of loadCorpus().records) if (record.flags.qaProbe) expect(ids.has(record.id)).toBe(false);
  });

  test('the committed checksums are those of the committed files', () => {
    const sha = (name: string) =>
      createHash('sha256')
        .update(readFileSync(new URL(name, DIR)))
        .digest('hex');
    expect(sha('corpus.jsonl')).toBe(loadCorpus().manifest.checksum);
    expect(existsSync(new URL('labels-agreement.json', DIR))).toBe(true);
    expect(loadRealHistory().labelsChecksum).toBe(sha('labels.jsonl'));
  });
});
