import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonCodec } from '../../src/utils/json-codec.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const resultCodec = jsonCodec(
  z.object({
    metricRows: z.number(),
    malformedRows: z.number(),
    requests: z.number(),
    byProvider: z.record(z.string(), z.object({ n: z.number(), failures: z.number() })),
  }),
);
function report(lines: string[]) {
  const d = mkdtempSync(join(tmpdir(), 'hcb-metrics-'));
  dirs.push(d);
  const file = join(d, 'data.jsonl');
  writeFileSync(file, lines.join('\n'));
  const run = Bun.spawnSync(
    [process.execPath, '--no-env-file', join(import.meta.dir, '../../scripts/report-ai-latency.ts'), file],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  expect(run.exitCode).toBe(0);
  const text = new TextDecoder().decode(run.stdout);
  return { text, data: resultCodec.parse(text) };
}
describe('production metric JSONL ingestion', () => {
  test('retains a real-shaped partially reported model call and null metadata without publishing content', () => {
    const lines = [
      {
        msg: 'AI model call metric',
        requestId: 'synthetic-a',
        purpose: 'agent',
        provider: 'groq',
        model: 'synthetic',
        chain: 'fast',
        firstUsableSinceAttemptMs: 5,
        providerDurationMs: 10,
        totalDurationMs: 12,
        attemptCount: 1,
        fallbackCount: 0,
        promptTokens: 100,
        completionTokens: 20,
        reasoningTokens: null,
        cachedTokens: null,
        success: true,
        userId: 123456,
        privateText: 'NEVER_PUBLISH',
      },
      {
        msg: 'AI model call metric',
        requestId: 'synthetic-b',
        purpose: 'validator',
        provider: null,
        model: null,
        chain: null,
        firstUsableSinceAttemptMs: null,
        providerDurationMs: null,
        totalDurationMs: 12,
        attemptCount: null,
        fallbackCount: null,
        promptTokens: null,
        completionTokens: null,
        reasoningTokens: null,
        cachedTokens: null,
        success: true,
      },
    ];
    const r = report(lines.map((v) => JSON.stringify(v)));
    expect(r.data.metricRows).toBe(2);
    expect(r.data.malformedRows).toBe(0);
    expect(Object.keys(r.data.byProvider)).toEqual(['groq:synthetic']);
    expect(r.data.byProvider['groq:synthetic']).toMatchObject({ n: 1, failures: 0 });
    expect(r.text).not.toContain('123456');
    expect(r.text).not.toContain('NEVER_PUBLISH');
  });
  test('rejects invalid numeric values rather than coercing them to null or zero', () => {
    const r = report([
      '{broken',
      JSON.stringify({ msg: 'AI model call metric', requestId: 'a', promptTokens: '100' }),
      JSON.stringify({ msg: 'AI model call metric', requestId: 'b', providerDurationMs: -5 }),
    ]);
    expect(r.data.malformedRows).toBe(3);
    expect(r.data.metricRows).toBe(0);
  });
});
