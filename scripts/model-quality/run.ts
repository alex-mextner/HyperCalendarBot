import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import OpenAI from 'openai';
import { z } from 'zod';
import { evaluate, type Fixture, summarize, type Trace } from './core.ts';
import { fixtures } from './fixtures.ts';
import { type Candidate, candidates } from './models.ts';
import { createSandbox, promptFor, tools } from './sandbox.ts';
import { billedOutputUpperEstimate } from './usage.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: 'string' },
    models: { type: 'string' },
    cases: { type: 'string' },
    repeats: { type: 'string', default: '1' },
    budget: { type: 'string', default: '1.5' },
    catalog: { type: 'boolean', default: false },
  },
  strict: true,
});
if (!values.out) throw new Error('--out unique directory required');
const out = resolve(values.out);
mkdirSync(out, { recursive: false, mode: 0o700 });
const ids = values.models?.split(',');
const selected = candidates.filter((x) => !ids || ids.includes(x.id));
if (!selected.length || ids?.some((x) => !selected.some((c) => c.id === x))) throw new Error('Unknown model selection');
const chosen = values.cases ? fixtures.filter((x) => values.cases!.split(',').includes(x.id)) : fixtures;
if (!chosen.length) throw new Error('No cases selected');
const repeats = Number(values.repeats),
  budget = Number(values.budget);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3 || !Number.isFinite(budget) || budget <= 0 || budget > 1.5)
  throw new Error('Invalid experiment budget/repeats');
const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe' }).stdout.toString().trim();
const sourceFiles = ['core.ts', 'fixtures.ts', 'sandbox.ts', 'models.ts', 'run.ts', 'usage.ts'];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (name) => [
      name,
      createHash('sha256')
        .update(await Bun.file(new URL(name, import.meta.url)).text())
        .digest('hex'),
    ]),
  ),
);
const manifest = {
  at: new Date().toISOString(),
  pid: process.pid,
  source,
  sourceHashes,
  fixturesHash: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
  selectedModels: selected.map(({ keyEnv, ...rest }) => rest),
  caseIds: chosen.map((x) => x.id),
  repeats,
  budgetUSD: budget,
  mode: 'nonstream full-production-prompt-and-schemas, simulated business tools, real calculator',
  privateHistorySent: false,
  fallback: false,
  maxRounds: 6,
  deadlineMs: 30000,
};
writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
mkdirSync(`${out}/source`, { mode: 0o700 });
for (const name of sourceFiles)
  writeFileSync(`${out}/source/${name}`, await Bun.file(new URL(name, import.meta.url)).text(), {
    flag: 'wx',
    mode: 0o600,
  });
writeFileSync(`${out}/fixtures.json`, `${JSON.stringify(chosen, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
let spentEnvelope = 0;
let requestCount = 0;
const nextAllowed = new Map<string, number>();
const objectSchema = z.record(z.string(), z.json());
interface Row extends Trace {
  candidate: string;
  caseId: string;
  family: string;
  repetition: number;
  pass: boolean;
  critical: boolean;
  reasons: string[];
  rounds: number;
  reportedTotalTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  usageMissing: boolean;
  costEstimateUSD: number;
  status: number | null;
  finishReasons: string[];
  errorDetail?: string;
  unknownCostReservationUSD?: number;
}
const rows: Row[] = [];
async function execute(candidate: Candidate, fixture: Fixture, repetition: number): Promise<Row> {
  const key = process.env[candidate.keyEnv];
  const trace: Row = {
    candidate: candidate.id,
    caseId: fixture.id,
    family: fixture.family,
    repetition,
    calls: [],
    text: '',
    durationMs: 0,
    error: null,
    incomplete: true,
    inputTokens: null,
    outputTokens: null,
    pass: false,
    critical: false,
    reasons: [],
    rounds: 0,
    reportedTotalTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    usageMissing: false,
    costEstimateUSD: 0,
    status: null,
    finishReasons: [],
  };
  if (!key) {
    trace.error = 'NO_KEY';
    return { ...trace, ...evaluate(fixture, trace) };
  }
  const client = new OpenAI({ apiKey: key, baseURL: candidate.baseURL, maxRetries: 0, timeout: 15000 });
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: promptFor(fixture) },
    { role: 'user', content: fixture.user },
  ];
  const sandbox = createSandbox(fixture);
  const started = performance.now();
  const deadline = Date.now() + 30000;
  let pendingReservation = 0;
  try {
    for (let round = 0; round < 6; round++) {
      const delay = Math.max(0, (nextAllowed.get(candidate.provider) ?? 0) - Date.now());
      if (delay > 0) await Bun.sleep(delay);
      // Provider pacing is accounted in elapsed time; it never silently earns a fresh request deadline.
      if (Date.now() >= deadline) throw new Error('REQUEST_DEADLINE');
      const payload = {
        model: candidate.model,
        messages,
        tools,
        temperature: 0,
        max_tokens: 4096,
        ...(candidate.effort ? { reasoning_effort: candidate.effort } : {}),
      };
      const reserve =
        (new TextEncoder().encode(JSON.stringify(payload)).length * candidate.inputPrice +
          4096 * candidate.outputPrice) /
        1e6;
      if (spentEnvelope + reserve > budget) throw new Error('EXPERIMENT_BUDGET');
      spentEnvelope += reserve;
      pendingReservation = reserve;
      requestCount++;
      trace.rounds++;
      const callStart = performance.now();
      nextAllowed.set(candidate.provider, Date.now() + (candidate.spacingMs ?? 120));
      const response = await client.chat.completions.create(payload, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))),
      });
      trace.status = 200;
      const usage = response.usage;
      if (usage) {
        trace.inputTokens = (trace.inputTokens ?? 0) + usage.prompt_tokens;
        trace.outputTokens = (trace.outputTokens ?? 0) + usage.completion_tokens;
        trace.reportedTotalTokens = (trace.reportedTotalTokens ?? 0) + usage.total_tokens;
        if (usage.completion_tokens_details?.reasoning_tokens != null)
          trace.reasoningTokens = (trace.reasoningTokens ?? 0) + usage.completion_tokens_details.reasoning_tokens;
        if (usage.prompt_tokens_details?.cached_tokens != null)
          trace.cachedTokens = (trace.cachedTokens ?? 0) + usage.prompt_tokens_details.cached_tokens;
        const cost =
          (usage.prompt_tokens * candidate.inputPrice +
            billedOutputUpperEstimate(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens) *
              candidate.outputPrice) /
          1e6;
        spentEnvelope += cost - reserve;
        trace.costEstimateUSD += cost;
        pendingReservation = 0;
      } else {
        trace.usageMissing = true;
        trace.costEstimateUSD += reserve;
      }
      const choice = response.choices[0];
      trace.finishReasons.push(choice?.finish_reason ?? 'missing');
      const message = choice?.message;
      const calls =
        message?.tool_calls?.filter((c): c is OpenAI.ChatCompletionMessageFunctionToolCall => c.type === 'function') ??
        [];
      appendFileSync(
        `${out}/rounds.jsonl`,
        `${JSON.stringify({
          candidate: candidate.id,
          caseId: fixture.id,
          repetition,
          round,
          requestId: response.id,
          elapsedMs: performance.now() - callStart,
          finish: choice?.finish_reason ?? null,
          usage: usage ?? null,
          responseShape: {
            messageFields: message ? Object.keys(message) : [],
            hasLegacyFunctionCall: !!message?.function_call,
            toolCallTypes: message?.tool_calls?.map((call) => call.type) ?? [],
            refusalPresent: !!message?.refusal,
          },
          text: message?.content ?? '',
          calls,
        })}\n`,
        { mode: 0o600 },
      );
      if (message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('SAFETY_STOP');
      if (!message) throw new Error('NO_CHOICE');
      if (!calls.length) {
        trace.text = message.content ?? '';
        if (!trace.text.trim()) throw new Error(`EMPTY_${choice?.finish_reason ?? 'unknown'}`);
        trace.incomplete = choice?.finish_reason === 'length';
        break;
      }
      if (choice?.finish_reason === 'length') throw new Error('TRUNCATED_TOOL_BATCH');
      const parsed = calls.map((call) => ({ ...call, args: objectSchema.parse(JSON.parse(call.function.arguments)) }));
      if (new Set(parsed.map((x) => x.id)).size !== parsed.length || parsed.some((x) => !x.id || !x.function.name))
        throw new Error('MALFORMED_TOOL_BATCH');
      messages.push({
        role: 'assistant',
        content: candidate.provider === 'together' ? (message.content ?? '') : message.content,
        tool_calls: calls,
      });
      let wait = false;
      for (const call of parsed) {
        if (wait) {
          trace.calls.push({ name: call.function.name, args: call.args, success: false, error: 'AFTER_WAIT' });
          continue;
        }
        const executed = sandbox.execute(call.function.name, call.args);
        trace.calls.push(executed.call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(executed.result) });
        wait = executed.wait;
      }
      const preliminary = evaluate(fixture, { ...trace, incomplete: false, error: null });
      if (wait || preliminary.critical) {
        trace.incomplete = false;
        break;
      }
    }
  } catch (error) {
    trace.error =
      error instanceof OpenAI.APIError
        ? `HTTP_${error.status ?? 'unknown'}`
        : error instanceof Error
          ? error.message.slice(0, 120)
          : 'UNKNOWN_ERROR';
    trace.usageMissing = trace.usageMissing || pendingReservation > 0;
    trace.unknownCostReservationUSD = pendingReservation;
    if (error instanceof OpenAI.APIError) {
      trace.status = error.status ?? null;
      let safe = error.message.slice(0, 600);
      for (const c of candidates) {
        const secret = process.env[c.keyEnv];
        if (secret) safe = safe.split(secret).join('[redacted]');
      }
      trace.errorDetail = safe;
      if (error.status === undefined) trace.error = error.name;
    }
    // Error bodies can echo inputs/keys; only bounded type/status are persisted.
  }
  trace.durationMs = performance.now() - started;
  return { ...trace, ...evaluate(fixture, trace) };
}
for (const candidate of selected) {
  if (values.catalog) {
    const key = process.env[candidate.keyEnv];
    if (!key) {
      console.log(JSON.stringify({ id: candidate.id, catalog: 'NO_KEY' }));
      continue;
    }
    const r = await fetch(`${candidate.baseURL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const data: unknown = await r.json();
    const parsed = z
      .union([z.array(z.object({ id: z.string() })), z.object({ data: z.array(z.object({ id: z.string() })) })])
      .safeParse(data);
    const names = parsed.success ? (Array.isArray(parsed.data) ? parsed.data : parsed.data.data).map((x) => x.id) : [];
    appendFileSync(
      `${out}/catalog.jsonl`,
      `${JSON.stringify({
        candidate: candidate.id,
        status: r.status,
        present: names.includes(candidate.model),
        relevant: names.filter((x) => /oss|qwen3\.[68]|glm-5/i.test(x)),
      })}\n`,
      { mode: 0o600 },
    );
    continue;
  }
  let stop = false;
  for (let repetition = 0; repetition < repeats && !stop; repetition++)
    for (const fixture of chosen) {
      const row = await execute(candidate, fixture, repetition);
      rows.push(row);
      appendFileSync(`${out}/results.jsonl`, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      console.log(
        JSON.stringify({
          model: row.candidate,
          case: row.caseId,
          rep: repetition,
          pass: row.pass,
          critical: row.critical,
          ms: Math.round(row.durationMs),
          rounds: row.rounds,
          error: row.error,
          reasons: row.reasons,
          spent: Math.round(spentEnvelope * 10000) / 10000,
        }),
      );
      if (
        ['NO_KEY', 'HTTP_401', 'HTTP_402', 'HTTP_403', 'HTTP_404', 'HTTP_429', 'EXPERIMENT_BUDGET'].includes(
          row.error ?? '',
        )
      ) {
        stop = true;
        break;
      }
    }
  writeFileSync(
    `${out}/summary.json`,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        spentEnvelopeUSD: spentEnvelope,
        requestCount,
        models: Object.fromEntries(selected.map((c) => [c.id, summarize(rows.filter((x) => x.candidate === c.id))])),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}
console.log(
  `RUN_COMPLETE ${JSON.stringify({ out, rows: rows.length, requestCount, spentEnvelopeUSD: spentEnvelope })}`,
);
