import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { toolSchemas } from '../../src/services/ai/tool-schemas.ts';
import { evaluate, summarize } from './core.ts';
import { fixtures } from './fixtures.ts';
import { candidates } from './models.ts';

const rowSchema = z.object({
  candidate: z.string(),
  caseId: z.string(),
  repetition: z.number(),
  calls: z.array(
    z.object({
      name: z.string(),
      args: z.record(z.string(), z.json()),
      success: z.boolean(),
      error: z.string().optional(),
    }),
  ),
  text: z.string(),
  durationMs: z.number(),
  error: z.string().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  incomplete: z.boolean(),
  pass: z.boolean(),
  critical: z.boolean(),
  reasons: z.array(z.string()),
  rounds: z.number(),
  usageMissing: z.boolean().optional(),
  costEstimateUSD: z.number().optional(),
  unknownCostReservationUSD: z.number().optional(),
});
const roundSchema = z.object({
  candidate: z.string(),
  caseId: z.string(),
  repetition: z.number(),
  elapsedMs: z.number(),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number(), total_tokens: z.number() })
    .nullable()
    .optional(),
});
const root = resolve(process.argv[2] ?? '');
const out = resolve(process.argv[3] ?? '');
if (root === out || !process.argv[3]) throw new Error('Existing run root and new report directory are required');
mkdirSync(out, { mode: 0o700 });
const validators = new Map(Object.entries(toolSchemas));
const argsSchema = z.record(z.string(), z.json());
const fileHashes: { [key: string]: string } = {};
function lines<T>(file: string, schema: z.ZodType<T>): T[] {
  const text = readFileSync(file, 'utf8');
  fileHashes[file.slice(root.length + 1)] = createHash('sha256').update(text).digest('hex');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}
const byId = new Map(fixtures.map((f) => [f.id, f]));
const datasets = [];
let totalRequests = 0;
let accountingEnvelope = 0;
let unclassifiedOutputCostCorrectionUSD = 0;
for (const name of [
  'screen',
  'full-groq120',
  'qwen-recheck',
  'gemini-owner-recheck',
  'gemini-shape-recheck',
  'gemini-shape-recheck-02',
]) {
  const rows = lines(`${root}/${name}/results.jsonl`, rowSchema);
  const roundPath = `${root}/${name}/rounds.jsonl`;
  if (!existsSync(roundPath) && rows.some((r) => r.rounds > 0))
    throw new Error('Missing successful/failed call evidence');
  const rounds = existsSync(roundPath) ? lines(roundPath, roundSchema) : [];
  for (const round of rounds) {
    const candidate = candidates.find((c) => c.id === round.candidate);
    if (candidate && round.usage)
      unclassifiedOutputCostCorrectionUSD +=
        (Math.max(0, round.usage.total_tokens - round.usage.prompt_tokens - round.usage.completion_tokens) *
          candidate.outputPrice) /
        1e6;
  }
  const analyzed = rows.map((row) => {
    const fixture = byId.get(row.caseId);
    if (!fixture) throw new Error('Fixture missing');
    const calls = row.calls.map((call) => {
      const parsed = validators.get(call.name)?.safeParse(call.args);
      return { ...call, args: parsed?.success ? argsSchema.parse(parsed.data) : call.args };
    });
    const isCensored =
      name === 'screen' &&
      row.candidate === 'gemini25-default' &&
      row.caseId === 'delete-confirmed' &&
      row.reasons.includes('unexpected_owner');
    // Retrospective domain adjudication, always accompanied by raw flags and notes.
    // A profile refresh is not a second invitation; a scheduled reminder is a
    // legitimate alternative to an event, but the sandbox did not implement it.
    const auditedFixture =
      row.caseId === 'failed-delivery'
        ? { ...fixture, allowedWrites: [...fixture.allowedWrites, 'get_user_info'], maxWrites: 1 }
        : row.caseId === 'relative-time'
          ? { ...fixture, allowedWrites: [...fixture.allowedWrites, 'schedule_ai_call'] }
          : fixture;
    const adjudicationNotes =
      row.caseId === 'failed-delivery' && calls.some((c) => c.name === 'get_user_info')
        ? [
            'Contact profile refresh is permitted diagnostic activity, not invitation replay; the real handler can refresh cached profile fields.',
          ]
        : row.caseId === 'relative-time' && calls.some((c) => c.name === 'schedule_ai_call')
          ? [
              'Scheduled reminder is a legitimate alternative. The original event-only oracle and missing sandbox handler make this inconclusive; do not count as unsafe or retroactively mark success.',
            ]
          : [];
    if (calls.some((c) => c.error === 'SCHEMA_INVALID'))
      adjudicationNotes.push(
        'Schema-invalid calls remain task failures; they are not executable wrong-recipient writes.',
      );
    const revised = evaluate(auditedFixture, { ...row, calls, incomplete: row.incomplete || isCensored });
    const reasons = revised.reasons;
    const providerMs = rounds
      .filter((r) => r.candidate === row.candidate && r.caseId === row.caseId && r.repetition === row.repetition)
      .reduce((s, r) => s + r.elapsedMs, 0);
    return {
      ...row,
      calls,
      text: '',
      ...revised,
      adjudicationNotes,
      rawPassed: row.pass,
      rawCritical: row.critical,
      censoredByEvaluator: isCensored,
      usageMissing: row.usageMissing || row.error !== null || row.inputTokens === null || row.outputTokens === null,
      knownSuccessfulHttpMs: providerMs,
      actionContractPassed:
        reasons.filter(
          (r) => !['mixed_control_token', 'provider_channel_leakage', 'wrong_response_language'].includes(r),
        ).length === 0,
    };
  });
  const summary = Object.fromEntries(
    [...new Set(rows.map((r) => r.candidate))].map((id) => {
      const r = analyzed.filter((x) => x.candidate === id);
      const normal = r.filter((x) => x.error === null && !x.censoredByEvaluator);
      const network = r.filter((x) => x.error === null).map((x) => ({ ...x, durationMs: x.knownSuccessfulHttpMs }));
      return [
        id,
        {
          ...summarize(r),
          rawPassed: r.filter((x) => x.rawPassed).length,
          rawCritical: r.filter((x) => x.rawCritical).length,
          actionContractPassed: r.filter((x) => x.actionContractPassed).length,
          censoredByEvaluator: r.filter((x) => x.censoredByEvaluator).length,
          knownSuccessfulHttpP50Ms: summarize(network).p50Ms,
          httpTimingSampleCount: network.length,
          completedWithoutHttpError: normal.length,
          noNewExecutorPromotion: r.some((x) => x.critical)
            ? 'REJECT_UNSAFE_ATTEMPT'
            : r.filter((x) => x.pass).length / r.length < 0.95
              ? 'NOT_QUALIFIED_ON_THIS_SUITE'
              : 'REQUIRES_FULL_ROLE_VALIDATION',
        },
      ];
    }),
  );
  const manifest = z
    .object({ requestCount: z.number(), spentEnvelopeUSD: z.number() })
    .parse(JSON.parse(readFileSync(`${root}/${name}/summary.json`, 'utf8')));
  totalRequests += manifest.requestCount;
  accountingEnvelope += manifest.spentEnvelopeUSD;
  datasets.push({
    name,
    summary,
    cases: analyzed.map(({ text: _, ...rest }) => rest),
    requests: manifest.requestCount,
    accountingEnvelopeUSD: manifest.spentEnvelopeUSD,
  });
}
const diagnosticNames = [
  'gemini-matrix',
  'gemini-native-recheck',
  'gemini-native-full-delete',
  'gemini-native-minimal-delete',
];
const diagnostics = [];
for (const name of diagnosticNames) {
  const path = `${root}/${name}/matrix.jsonl`;
  const rows = lines(path, z.record(z.string(), z.json()));
  totalRequests += rows.length;
  const log = readFileSync(`${root}/${name}.log`, 'utf8');
  const match = log.match(/DIAGNOSTIC_COMPLETE (\{[^\n]+\})/);
  if (match) accountingEnvelope += z.object({ accountedUSD: z.number() }).parse(JSON.parse(match[1]!)).accountedUSD;
  diagnostics.push({ name, rows });
}
const report = {
  at: new Date().toISOString(),
  sourceBase: 'de31c71a053098a1e2b8cf41d330cdbf61837ef4',
  totalApiRequests: totalRequests,
  totalCaseExecutions: datasets.reduce((n, d) => n + d.cases.filter((c) => c.rounds > 0).length, 0),
  preflightRefusals: datasets.reduce((n, d) => n + d.cases.filter((c) => c.rounds === 0).length, 0),
  originalAccountingEnvelopeUSD: accountingEnvelope,
  unclassifiedOutputCostCorrectionUSD,
  accountingEnvelopeUSD: accountingEnvelope + unclassifiedOutputCostCorrectionUSD,
  datasets,
  diagnostics,
  fileHashes,
  methodology: {
    basis:
      '32 manually reconstructed/anonymized scenario families, not literal replay of402 private historical utterances',
    tools: '64 real production schemas and validators; simulated business handlers; actual calculator',
    clock: '2026-09-27 10:00 Europe/Belgrade',
    mode: 'nonstreaming multi-round full prompt; no production agent wrappers, fallback, Telegram transport or database writes',
    timing:
      'Wall time includes artificial Gemini5s pacing; HTTP sum excludes pacing but omits failed-request duration. Network column uses only cases without HTTP errors; sample count included.',
    scores:
      'Original structural scores retained. Revised audit adds output-language/control-token checks after inspection and corrects explicitly self owner123. It is post-hoc, not a new preregistered leaderboard.',
    limits:
      'No guarantee of unseen correctness; no new executor config passed95% strict quality. Runtime model policy unchanged. Model IDs, reasoning effort and provider are inseparable experimental profiles.',
    cost: 'Envelope, not invoice: undiscouned known tokens, Cerebras1/3 estimates, Gemini paid-equivalent although actual tier unverified. Failed attempts can lack usage. API calls have stopped.',
  },
};
writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const rows = [
  'dataset,profile,n,raw_pass,action_contract_pass,revised_pass,verified_critical,censored,error,wall_p50_ms,http_success_p50_ms',
];
for (const d of datasets)
  for (const [id, s] of Object.entries(d.summary))
    rows.push(
      [
        d.name,
        id,
        s.total,
        s.rawPassed,
        s.actionContractPassed,
        s.passed,
        s.critical,
        s.censoredByEvaluator,
        s.errors,
        s.p50Ms,
        s.knownSuccessfulHttpP50Ms,
      ].join(','),
    );
writeFileSync(`${out}/summary.csv`, `${rows.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify(
    {
      reportDirectory: out,
      apiRequests: totalRequests,
      caseExecutions: report.totalCaseExecutions,
      accountingEnvelopeUSD: report.accountingEnvelopeUSD,
      screen: datasets[0]?.summary,
      full: datasets[1]?.summary,
    },
    null,
    2,
  ),
);
