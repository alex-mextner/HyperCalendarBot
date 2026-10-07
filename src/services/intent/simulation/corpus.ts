// Readers for the coverage harness's inputs: the committed synthetic fixtures and the private
// retained corpus with its independently produced labels. The private files are read by path
// only (never copied); their shapes are the 2026-09-19 learning run's `semantic-cases.json` and
// `semantic-small-NNN.json` label batches with `.receipt.json` receipts. A label batch whose
// receipt is not `completed` keeps its labels but marks them `unverified`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonCodec } from '../../../utils/json-codec.ts';
import { RevisionBodyCodec } from '../revision-body.ts';
import { seedIntents } from '../seed-catalog.ts';
import type { CanonicalSeed } from '../seed-replacement.ts';
import { BUCKETS, type Bucket, type CaseLabel, type CoverageCase, LABEL_CLASSES } from './coverage.ts';

const LabelSchema = z.object({
  class: z.enum(LABEL_CLASSES),
  family: z.string(),
  expectedTools: z.array(z.string()),
  idealResponse: z.string().nullable(),
});
const EventSchema = z.object({ title: z.string(), start: z.string(), end: z.string().optional() });
const FixtureFileCodec = jsonCodec(
  z.object({
    schemaVersion: z.literal(1),
    defaults: z.object({ at: z.string(), timezone: z.string() }),
    calendars: z.record(z.string(), z.array(EventSchema)),
    cases: z.array(
      z.object({
        caseId: z.string(),
        origin: z.string(),
        request: z.string(),
        language: z.enum(['ru', 'en']),
        calendar: z.string(),
        at: z.string().optional(),
        timezone: z.string().optional(),
        sensitive: z.boolean().optional(),
        label: LabelSchema,
        historicalAnswer: z.string().nullable(),
        expectedBucket: z.enum(BUCKETS),
      }),
    ),
  }),
);

const TurnSchema = z.object({ role: z.string(), text: z.string(), createdAt: z.string() });
const PrivateCorpusCodec = jsonCodec(
  z.array(
    z.object({
      caseId: z.string(),
      request: z.string(),
      createdAt: z.string(),
      timezoneAssumption: z.string(),
      historical: z.array(TurnSchema),
      sensitiveExcluded: z.boolean(),
    }),
  ),
);
const RawCorpusCodec = jsonCodec(z.array(z.object({ text: z.string() })));
const LabelBatchCodec = jsonCodec(
  z.object({
    cases: z.array(
      z.object({
        caseId: z.string(),
        class: z.enum(LABEL_CLASSES),
        family: z.string(),
        expectedTools: z.array(z.string()),
        idealResponse: z.string().nullable().optional(),
      }),
    ),
  }),
);
const ReceiptCodec = jsonCodec(z.object({ status: z.string() }));
const ChatMessageCodec = jsonCodec(z.object({ role: z.string(), content: z.string().nullable().optional() }));
const ContentBlocksCodec = jsonCodec(z.array(z.object({ type: z.string(), text: z.string().optional() })));

const readText = (path: string) => readFileSync(path, 'utf8');

/** Refuses a case whose zone the runtime does not know, by case id, before any case runs. */
function knownZone(caseId: string, timezone: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    // RangeError is the only failure here; the case id is what the operator needs.
    throw new Error(`Case ${caseId} has an unknown time zone: ${timezone}`);
  }
  return timezone;
}

export function loadFixtureCases(path: string): {
  cases: CoverageCase[];
  origins: string[];
  expectedBuckets: { [caseId: string]: Bucket };
} {
  const file = FixtureFileCodec.parse(readText(path));
  const cases = file.cases.map((fixture): CoverageCase => {
    const calendar = file.calendars[fixture.calendar];
    if (!calendar) throw new Error(`Fixture ${fixture.caseId} names unknown calendar ${fixture.calendar}`);
    return {
      caseId: fixture.caseId,
      request: fixture.request,
      at: fixture.at ?? file.defaults.at,
      timezone: knownZone(fixture.caseId, fixture.timezone ?? file.defaults.timezone),
      language: fixture.language,
      calendar,
      label: fixture.label,
      sensitive: fixture.sensitive ?? false,
      historicalAnswer: fixture.historicalAnswer,
      labelProvenance: 'verified',
    };
  });
  return {
    cases,
    origins: [...new Set(file.cases.map((fixture) => fixture.origin))],
    expectedBuckets: Object.fromEntries(file.cases.map((fixture) => [fixture.caseId, fixture.expectedBucket])),
  };
}

/** Every human-readable string of the fixture file: requests, answers and calendar titles. */
export function fixtureStrings(path: string): string[] {
  const file = FixtureFileCodec.parse(readText(path));
  const titles = Object.values(file.calendars).flatMap((events) => events.map((event) => event.title));
  const answers = file.cases.flatMap((fixture) => [fixture.historicalAnswer, fixture.label.idealResponse]);
  return [...file.cases.map((fixture) => fixture.request), ...answers, ...titles].filter(
    (text): text is string => typeof text === 'string',
  );
}

/** Request strings of a private corpus file in either retained shape (`text` or `request`). */
export function privateRequestStrings(path: string): string[] {
  const raw = readText(path);
  const labelled = PrivateCorpusCodec.safeParse(raw);
  if (labelled.success) return labelled.data.map((record) => record.request);
  return RawCorpusCodec.parse(raw).map((record) => record.text);
}

/** Final assistant text of a stored turn: an OpenAI-style message or an array of content blocks. */
function assistantText(stored: string): string | null {
  const message = ChatMessageCodec.safeParse(stored);
  if (message.success) return message.data.content?.trim() || null;
  const blocks = ContentBlocksCodec.safeParse(stored);
  if (!blocks.success) return null;
  const text = blocks.data
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
    .trim();
  return text || null;
}

function historicalAnswer(turns: z.infer<typeof TurnSchema>[]): string | null {
  for (const turn of [...turns].reverse()) {
    if (turn.role !== 'assistant') continue;
    const text = assistantText(turn.text);
    if (text) return text;
  }
  return null;
}

function loadLabels(labelsDir: string): Map<string, { label: CaseLabel; verified: boolean }> {
  const labels = new Map<string, { label: CaseLabel; verified: boolean }>();
  const batches = readdirSync(labelsDir).filter((name) => /^semantic-small-\d{3}\.json$/.test(name));
  for (const name of batches.sort()) {
    const receiptPath = join(labelsDir, name.replace(/\.json$/, '.receipt.json'));
    const receipt = existsSync(receiptPath) ? ReceiptCodec.safeParse(readText(receiptPath)) : null;
    const verified = receipt?.success === true && receipt.data.status === 'completed';
    for (const row of LabelBatchCodec.parse(readText(join(labelsDir, name))).cases) {
      if (labels.has(row.caseId)) throw new Error(`Label for ${row.caseId} appears in more than one batch`);
      const { class: labelClass, family, expectedTools, idealResponse } = row;
      const label = { class: labelClass, family, expectedTools, idealResponse: idealResponse ?? null };
      labels.set(row.caseId, { label, verified });
    }
  }
  return labels;
}

/** `createdAt` of the retained corpus is UTC without a zone suffix ("YYYY-MM-DD HH:MM:SS"). */
function utcInstant(createdAt: string): string {
  const date = new Date(createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid case time: ${createdAt}`);
  return date.toISOString();
}

export function loadPrivateCorpus(corpusPath: string, labelsDir: string): CoverageCase[] {
  const labels = loadLabels(labelsDir);
  return PrivateCorpusCodec.parse(readText(corpusPath)).map((record): CoverageCase => {
    const labelled = labels.get(record.caseId);
    return {
      caseId: record.caseId,
      request: record.request,
      at: utcInstant(record.createdAt),
      timezone: knownZone(record.caseId, record.timezoneAssumption),
      language: /[а-яё]/i.test(record.request) ? 'ru' : 'en',
      calendar: [],
      label: labelled?.label ?? null,
      sensitive: record.sensitiveExcluded,
      historicalAnswer: historicalAnswer(record.historical),
      labelProvenance: labelled ? (labelled.verified ? 'verified' : 'unverified') : 'missing',
    };
  });
}

/**
 * A rule set to measure: `seed` is the source catalogue; a path is an exported revision body. Only a
 * `replace_all` body names a complete rule set; an `operations` body is a change against some base
 * and is refused.
 */
export function loadRuleSource(source: string): CanonicalSeed[] {
  if (source === 'seed') return [...seedIntents];
  const body = RevisionBodyCodec.parse(readText(source));
  if (body.type !== 'replace_all')
    throw new Error(`${source} is an ${body.type} revision body; only a replace_all body names a complete rule set`);
  return body.rules.map((rule) => {
    const { workflow } = rule;
    if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow))
      throw new Error(`Rule ${rule.canonical_name} in ${source} has no workflow object`);
    return { ...rule, workflow };
  });
}
