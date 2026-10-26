// Runs the intent benchmark: the model history through the real intent layer for one rule set, optionally across the
// TZ/DST matrix, and aggregates the KPIs. Import ./quiet.ts before this module in an entry point.
import { Database } from 'bun:sqlite';
import { setSystemTime } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedFingerprint } from '../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { type CanonicalSeed, intentRows } from '../../src/services/intent/seed-replacement.ts';
import { defaultAnchor, matrixAnchors, weekdayIndex } from './anchor.ts';
import { type Conversation, ConversationSchema, expandPlaceholders, WEEKDAYS, ZONES } from './history.ts';
import { failureClasses, familyOf, findingCodes, groupBy, percentile, type Slice, summarize } from './metrics.ts';
import { type RunResult, runConversation } from './run.ts';
import { buildTemplate } from './world.ts';

const ABSOLUTE_DATE =
  /\d{1,2}(?:-?го)?\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|(?<![\d:])\d{1,2}[./]\d{1,2}(?![\d:])|\d{4}-\d{2}-\d{2}/iu;
const HISTORY_DIR = new URL('../../docs/intents/model-history/', import.meta.url);
export const REPORT_SCHEMA_VERSION = 2;

const Manifest = z.object({
  version: z.number(),
  checksum: z.string(),
  files: z.object({ dev: z.object({ sha256: z.string() }), heldout: z.object({ sha256: z.string() }) }),
});

export interface LoadedHistory {
  version: number;
  checksum: string;
  dev: Conversation[];
  heldout: Conversation[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The committed model history; refuses a file whose bytes differ from the manifest. */
export function loadHistory(): LoadedHistory {
  const manifest = Manifest.parse(JSON.parse(readFileSync(new URL('manifest.json', HISTORY_DIR), 'utf8')));
  const read = (split: 'dev' | 'heldout'): Conversation[] => {
    const text = readFileSync(new URL(`conversations.${split}.jsonl`, HISTORY_DIR), 'utf8');
    if (sha256(text) !== manifest.files[split].sha256)
      throw new Error(`conversations.${split}.jsonl differs from manifest.json`);
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ConversationSchema.parse(JSON.parse(line)) as Conversation);
  };
  return { version: manifest.version, checksum: manifest.checksum, dev: read('dev'), heldout: read('heldout') };
}

const RuleList = z.array(
  z.object({
    canonical_name: z.string(),
    pattern: z.string(),
    workflow: z.looseObject({}),
    phrases: z.array(z.string()),
    trigger_words: z.array(z.string()),
    source_message: z.string(),
  }),
);

/** `current` is the seed in this source tree; anything else is a JSON file holding an array of rules. */
export function loadRules(spec: string): readonly CanonicalSeed[] {
  if (spec === 'current') return seedIntents;
  return RuleList.parse(JSON.parse(readFileSync(spec, 'utf8')));
}

export interface BenchmarkOptions {
  rules: readonly CanonicalSeed[];
  label: string;
  /** Run every Nth conversation through the TZ/DST matrix; 0 skips the matrix. */
  matrixStep: number;
  /** Repetitions of the matcher latency probe. */
  latencyRounds: number;
}

export interface Latency {
  matcherMicrosP50: number | null;
  matcherMicrosP95: number | null;
  matcherMicrosMax: number | null;
  layerMsP50: number | null;
  layerMsP95: number | null;
  samples: number;
}

function latencyOf(
  matcher: IntentMatcher,
  texts: readonly string[],
  rounds: number,
  results: readonly RunResult[],
): Latency {
  const micros: number[] = [];
  for (let round = 0; round < rounds; round++)
    for (const text of texts) {
      const started = performance.now();
      matcher.explain(text);
      micros.push((performance.now() - started) * 1000);
    }
  micros.sort((a, b) => a - b);
  const layer = results
    .filter((result) => result.turns[0]?.handled === true)
    .map((result) => result.turns[0]?.elapsedMs ?? 0)
    .sort((a, b) => a - b);
  return {
    matcherMicrosP50: percentile(micros, 0.5),
    matcherMicrosP95: percentile(micros, 0.95),
    matcherMicrosMax: micros.at(-1) ?? null,
    layerMsP50: percentile(layer, 0.5),
    layerMsP95: percentile(layer, 0.95),
    samples: micros.length,
  };
}

export interface SplitReport {
  overall: Slice;
  byFamily: { [family: string]: Slice };
  byStyle: { [style: string]: Slice };
  byRule: { [rule: string]: number };
  failureClasses: { [reason: string]: number };
  rubricFindings: { [code: string]: number };
}

function reportOf(results: readonly RunResult[]): SplitReport {
  const byRule: { [rule: string]: number } = {};
  for (const result of results)
    if (result.ruleName && result.verdict.outcome === 'correct')
      byRule[result.ruleName] = (byRule[result.ruleName] ?? 0) + 1;
  const styled = results.flatMap((result) =>
    (result.conversation.styles ?? ['plain']).map((style) => ({ style, result })),
  );
  const byStyle: { [style: string]: Slice } = {};
  for (const style of new Set(styled.map((item) => item.style)))
    byStyle[style] = summarize(styled.filter((item) => item.style === style).map((item) => item.result));
  return {
    overall: summarize(results),
    byFamily: groupBy(results, familyOf),
    byStyle,
    byRule: Object.fromEntries(Object.entries(byRule).sort((a, b) => b[1] - a[1])),
    failureClasses: failureClasses(results),
    rubricFindings: findingCodes(results),
  };
}

/** Real-history view: precision claims use `confirmed` labels only; `unclear` ones stay in coverage analysis. */
export interface RealReport {
  confirmed: { dev: SplitReport; heldout: SplitReport; all: SplitReport };
  unclear: { dev: Slice; heldout: Slice };
  byUser: { [user: string]: Slice };
}

export interface BenchmarkRun {
  results: { dev: RunResult[]; heldout: RunResult[]; matrix: RunResult[] };
  report: {
    schemaVersion: number;
    label: string;
    ruleSet: { fingerprint: string; rules: number };
    modelHistory: { version: number; checksum: string };
    dev: SplitReport;
    heldout: SplitReport;
    all: SplitReport;
    matrix: (SplitReport & { cells: number; anchors: number }) | null;
    real: RealReport | null;
    latency: Latency;
  };
}

export async function runBenchmark(
  options: BenchmarkOptions,
  history: LoadedHistory = loadHistory(),
): Promise<BenchmarkRun> {
  const template = buildTemplate(options.rules);
  const db = Database.deserialize(template.image);
  const matcher = new IntentMatcher();
  matcher.load(intentRows(db));
  db.close();
  const deps = { template, matcher };
  const runSplit = async (split: 'dev' | 'heldout', conversations: readonly Conversation[]): Promise<RunResult[]> => {
    const out: RunResult[] = [];
    for (const conversation of conversations)
      out.push(await runConversation(deps, conversation, defaultAnchor(conversation), conversation.id ?? split));
    return out;
  };
  const dev = await runSplit('dev', history.dev);
  const heldout = await runSplit('heldout', history.heldout);
  const matrix: RunResult[] = [];
  let anchorCount = 0;
  if (options.matrixStep > 0) {
    const everything = [...history.dev, ...history.heldout];
    for (const tz of ZONES) {
      const anchors = matrixAnchors(tz);
      anchorCount = Math.max(anchorCount, anchors.length);
      for (const anchor of anchors)
        for (const [index, conversation] of everything.entries()) {
          if (index % options.matrixStep !== 0) continue;
          // Real messages: unclear labels carry no verdict, and a spelled-out calendar date ("19 июня", "30.10") names one
          // fixed day that no other anchor can replay (the label's offsets belong to the recorded date).
          if (conversation.real && (conversation.real.status !== 'confirmed' || ABSOLUTE_DATE.test(conversation.say)))
            continue;
          // "That time has already passed" is likewise a fact about the recorded clock: on an earlier anchor the same words
          // name a future time and a rule is right to create the event, so a real message labelled so is not replayed.
          if (conversation.real && conversation.expect.route === 'ai' && conversation.expect.why === 'past_or_invalid')
            continue;
          // "The named weekday is today" is a fact about the conversation's own clock; on another anchor's weekday the
          // same words name a different day and a rule is right to answer, so the premise is not replayed there.
          if (
            conversation.expect.route === 'ai' &&
            conversation.expect.why === 'ambiguous_day' &&
            weekdayIndex(anchor.date) !== WEEKDAYS.indexOf(conversation.clock.day)
          )
            continue;
          matrix.push(
            await runConversation(
              deps,
              { ...conversation, tz },
              anchor,
              `${conversation.id ?? index}@${tz}/${anchor.label}`,
            ),
          );
        }
    }
  }
  // Fixtures freeze the clock; give it back so the report's timestamp is real.
  setSystemTime();
  const texts = [...history.dev, ...history.heldout]
    .map((conversation) => conversation.say)
    .map((say) => expandPlaceholders(say, { y: 2026, m: 10, d: 5 }));
  const isConfirmed = (result: RunResult): boolean => result.conversation.real?.status === 'confirmed';
  const isUnclear = (result: RunResult): boolean => result.conversation.real?.status === 'unclear';
  const hasReal = [...dev, ...heldout].some((result) => result.conversation.real !== undefined);
  const real: RealReport | null = hasReal
    ? {
        confirmed: {
          dev: reportOf(dev.filter(isConfirmed)),
          heldout: reportOf(heldout.filter(isConfirmed)),
          all: reportOf([...dev, ...heldout].filter(isConfirmed)),
        },
        unclear: { dev: summarize(dev.filter(isUnclear)), heldout: summarize(heldout.filter(isUnclear)) },
        byUser: Object.fromEntries(
          Object.entries(
            groupBy([...dev, ...heldout].filter(isConfirmed), (result) => result.conversation.real?.user),
          ).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }
    : null;
  return {
    results: { dev, heldout, matrix },
    report: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      label: options.label,
      ruleSet: { fingerprint: seedFingerprint(options.rules), rules: options.rules.length },
      modelHistory: { version: history.version, checksum: history.checksum },
      dev: reportOf(dev),
      heldout: reportOf(heldout),
      all: reportOf([...dev, ...heldout]),
      matrix: matrix.length > 0 ? { ...reportOf(matrix), cells: matrix.length, anchors: anchorCount } : null,
      real,
      latency: latencyOf(matcher, texts, options.latencyRounds, [...dev, ...heldout]),
    },
  };
}
