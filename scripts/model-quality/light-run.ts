import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import { z } from 'zod';
import { gradeLight, instructions, lightCases, lightSchemas } from './light-cases.ts';
import { candidates } from './models.ts';
import { billedOutputUpperEstimate } from './usage.ts';

const out = process.argv[2];
if (!out) throw new Error('New output directory required');
mkdirSync(out, { mode: 0o700 });
const selected = ['groq-20-low', 'gemini25-none', 'gemini35-lite-low', 'groq-qwen38'];
const repeats = 3,
  capUSD = 0.3;
let accounted = 0;
interface LightRow {
  candidate: string;
  model?: string;
  caseId: string;
  role: string;
  repetition: number;
  pass: boolean;
  ms: number;
  error: string | null;
  finish: string | null;
  content: string;
  usage: OpenAI.CompletionUsage | null;
  costEstimateUSD: number | null;
}
const rows: LightRow[] = [];
writeFileSync(
  `${out}/manifest.json`,
  `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, models: selected, repeats, capUSD, fixtureHash: createHash('sha256').update(JSON.stringify(lightCases)).digest('hex'), roles: Object.keys(instructions), maxOutput: 1536, deadlineMs: 8000, sideEffects: 0 }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 },
);
writeFileSync(`${out}/fixtures.json`, `${JSON.stringify(lightCases, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
for (const id of selected) {
  const c = candidates.find((c) => c.id === id);
  if (!c) throw new Error('Unknown profile');
  const key = process.env[c.keyEnv];
  if (!key) {
    console.log(`NO_KEY ${id}`);
    continue;
  }
  const client = new OpenAI({ apiKey: key, baseURL: c.baseURL, maxRetries: 0, timeout: 8000 });
  let stop = false;
  for (let repetition = 0; repetition < repeats && !stop; repetition++)
    for (const fixture of lightCases) {
      const jsonSchema = z.toJSONSchema(lightSchemas[fixture.role]);
      const payload = {
        model: c.model,
        messages: [
          { role: 'system' as const, content: instructions[fixture.role] },
          { role: 'user' as const, content: fixture.input },
        ],
        temperature: c.temperature ?? 0,
        max_tokens: 1536,
        ...(c.effort ? { reasoning_effort: c.effort } : {}),
        response_format: {
          type: 'json_schema' as const,
          json_schema: { name: fixture.role, strict: true, schema: jsonSchema },
        },
      };
      const reserve = (Buffer.byteLength(JSON.stringify(payload)) * c.inputPrice + 1536 * c.outputPrice) / 1e6;
      if (accounted + reserve > capUSD) {
        stop = true;
        console.log(`BUDGET_STOP ${id}`);
        break;
      }
      accounted += reserve;
      await Bun.sleep(c.provider === 'gemini' ? 250 : 60);
      const started = performance.now();
      let row: LightRow;
      try {
        const response = await client.chat.completions.create(payload, { signal: AbortSignal.timeout(8000) });
        const choice = response.choices[0];
        const content = choice?.message.content ?? '';
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(content);
        } catch {}
        const usage = response.usage;
        const cost = usage
          ? (usage.prompt_tokens * c.inputPrice +
              billedOutputUpperEstimate(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens) *
                c.outputPrice) /
            1e6
          : null;
        if (cost !== null) accounted += cost - reserve;
        row = {
          candidate: id,
          model: response.model,
          caseId: fixture.id,
          role: fixture.role,
          repetition,
          pass: choice?.finish_reason === 'stop' && gradeLight(fixture, parsed),
          ms: performance.now() - started,
          error: null,
          finish: choice?.finish_reason ?? null,
          content,
          usage: usage ?? null,
          costEstimateUSD: cost,
        };
      } catch (error) {
        const status = error instanceof OpenAI.APIError ? (error.status ?? null) : null;
        row = {
          candidate: id,
          caseId: fixture.id,
          role: fixture.role,
          repetition,
          pass: false,
          ms: performance.now() - started,
          error: status ? `HTTP_${status}` : error instanceof Error ? error.name : 'unknown',
          finish: null,
          content: '',
          usage: null,
          costEstimateUSD: null,
        };
        if ([401, 402, 403, 404, 429].includes(status ?? 0)) stop = true;
      }
      rows.push(row);
      appendFileSync(`${out}/results.jsonl`, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (!row.pass)
        console.log(
          JSON.stringify({ candidate: id, caseId: fixture.id, repetition, error: row.error, finish: row.finish }),
        );
      if (stop) break;
    }
  const summary = selected.map((id) => ({
    id,
    roles: Object.fromEntries(
      ['catalog', 'extraction', 'outcome'].map((role) => {
        const subset = rows.filter((r) => r.candidate === id && r.role === role);
        const ms = subset.map((r) => r.ms).sort((a, b) => a - b);
        return [
          role,
          {
            n: subset.length,
            passed: subset.filter((r) => r.pass).length,
            errors: subset.filter((r) => r.error).length,
            p50Ms: ms[Math.max(0, Math.ceil(ms.length * 0.5) - 1)] ?? null,
            p95Ms: ms[Math.max(0, Math.ceil(ms.length * 0.95) - 1)] ?? null,
          },
        ];
      }),
    ),
  }));
  writeFileSync(
    `${out}/summary.json`,
    `${JSON.stringify({ at: new Date().toISOString(), accountedUSD: accounted, requests: rows.length, summary }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`MODEL_COMPLETE ${JSON.stringify(summary.find((x) => x.id === id))}`);
}
console.log(`LIGHT_COMPLETE ${JSON.stringify({ accountedUSD: accounted, requests: rows.length })}`);
