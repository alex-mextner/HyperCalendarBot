// The real-history evaluation set: scrubbed real messages (docs/intents/real-history/corpus.jsonl), their labels
// (labels.jsonl, two independent annotators plus adjudication) and a frozen dev/held-out split (split.json).
// The split is stratified by user and family and decided once; relabelling never reshuffles it, and the held-out part
// is not read while rules are tuned.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { LoadedHistory } from './benchmark.ts';
import { type Conversation, ConversationSchema, ZONES } from './history.ts';
import { Label, type LabelLine } from './reconcile-labels.ts';

const DIR = new URL('../../docs/intents/real-history/', import.meta.url);
export const HELDOUT_SHARE = 0.34;
export const MIN_HELDOUT_SHARE = 0.3;
const SPLIT_SALT = 'real-split-v1';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const readText = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');

const CorpusRecordSchema = z.object({
  id: z.string().regex(/^rh-\d{4}$/),
  user: z.string().regex(/^u\d{2}$/),
  lang: z.enum(['ru', 'en']),
  chat: z.enum(['private', 'group']),
  tz: z.enum(ZONES),
  clock: z.object({ day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), at: z.string() }),
  date: z.string(),
  say: z.string(),
  flags: z.object({ qaProbe: z.boolean() }),
});
export type CorpusRecord = z.infer<typeof CorpusRecordSchema>;

const Manifest = z.object({
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  records: z.number().int(),
  scrubberVersion: z.string(),
  leakGates: z.object({ passed: z.literal(true) }).passthrough(),
});

const Split = z.object({
  schemaVersion: z.literal(1),
  heldoutShare: z.number(),
  corpusChecksum: z.string(),
  dev: z.array(z.string()),
  heldout: z.array(z.string()),
});
export type SplitFile = z.infer<typeof Split>;

export function loadCorpus(): { records: CorpusRecord[]; checksum: string; manifest: z.infer<typeof Manifest> } {
  const text = readText('corpus.jsonl');
  const manifest = Manifest.parse(JSON.parse(readText('manifest.json')));
  const checksum = sha256(text);
  if (checksum !== manifest.checksum) throw new Error('corpus.jsonl differs from manifest.json');
  const records = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => CorpusRecordSchema.parse(JSON.parse(line)));
  if (records.length !== manifest.records) throw new Error('corpus.jsonl record count differs from manifest.json');
  return { records, checksum, manifest };
}

export function loadLabels(): { labels: Map<string, LabelLine>; checksum: string } {
  const text = readText('labels.jsonl');
  const labels = new Map<string, LabelLine>();
  for (const line of text.split('\n').filter((row) => row.trim().length > 0)) {
    const label = Label.parse(JSON.parse(line));
    labels.set(label.id, label);
  }
  return { labels, checksum: sha256(text) };
}

/** Family key a record is stratified by. */
export const familyKey = (label: LabelLine): string =>
  label.expect.route === 'rule' ? label.expect.family : `ai:${label.expect.why}`;

/**
 * Held-out share by error diffusion over strata (user × family): every stratum of two or more records keeps at least
 * one record on each side, singletons go to whichever side the running deficit asks for, and the total share stays
 * within one record of the target. Order inside a stratum is a salted hash of the id, not the corpus order.
 */
export function assignSplit(
  records: readonly CorpusRecord[],
  labels: ReadonlyMap<string, LabelLine>,
): { dev: string[]; heldout: string[] } {
  const strata = new Map<string, string[]>();
  for (const record of records) {
    const label = labels.get(record.id);
    if (!label) throw new Error(`no label for ${record.id}`);
    const key = `${record.user}|${familyKey(label)}`;
    strata.set(key, [...(strata.get(key) ?? []), record.id]);
  }
  const dev: string[] = [];
  const heldout: string[] = [];
  let carry = 0;
  for (const key of [...strata.keys()].sort()) {
    const ids = (strata.get(key) ?? []).sort((a, b) =>
      sha256(`${SPLIT_SALT}:${a}`).localeCompare(sha256(`${SPLIT_SALT}:${b}`)),
    );
    const want = ids.length * HELDOUT_SHARE + carry;
    const count = ids.length === 1 ? (want >= 0.5 ? 1 : 0) : Math.min(ids.length - 1, Math.max(1, Math.round(want)));
    carry = want - count;
    heldout.push(...ids.slice(0, count));
    dev.push(...ids.slice(count));
  }
  return { dev: dev.sort(), heldout: heldout.sort() };
}

export function writeSplit(): SplitFile {
  const { records, checksum } = loadCorpus();
  const { labels } = loadLabels();
  const usable = records.filter((record) => !record.flags.qaProbe);
  const { dev, heldout } = assignSplit(usable, labels);
  const share = heldout.length / (dev.length + heldout.length);
  if (share < MIN_HELDOUT_SHARE) throw new Error(`held-out share ${share} is below ${MIN_HELDOUT_SHARE}`);
  const split: SplitFile = {
    schemaVersion: 1,
    heldoutShare: Number(share.toFixed(4)),
    corpusChecksum: checksum,
    dev,
    heldout,
  };
  writeFileSync(new URL('split.json', DIR), `${JSON.stringify(split, null, 1)}\n`);
  return split;
}

export interface LoadedRealHistory extends LoadedHistory {
  labelsChecksum: string;
  splitChecksum: string;
  corpusChecksum: string;
  excludedQaProbes: number;
}

/**
 * The events the label's fixture holds. A message that names an event ("#643", or by its title) needs that event to
 * exist (labelling rule 4: the calendar holds what the message refers to), so a reference without a seed event gets
 * one: with that number, or titled with the words of the reference.
 */
function seedEventsOf(label: LabelLine): LabelLine['seedEvents'] {
  const ref =
    label.expect.route === 'rule' ? (label.expect.slots.ref as { id?: number; title?: string } | undefined) : undefined;
  if (label.seedEvents) {
    // The event the annotator seeded is the one the message numbers.
    const [first, ...others] = label.seedEvents;
    return first && typeof ref?.id === 'number' && !label.seedEvents.some((event) => event.id === ref.id)
      ? [{ ...first, id: ref.id }, ...others]
      : label.seedEvents;
  }
  if (typeof ref?.id === 'number')
    return [{ id: ref.id, title: `Событие ${ref.id}`, dayOffset: 1, at: '12:00', durationMin: 60 }];
  if (typeof ref?.title === 'string') return [{ title: ref.title, dayOffset: 1, at: '12:00', durationMin: 60 }];
  return undefined;
}

/** The historical bot appended its own supplement to some stored user messages; the user never typed it. */
const AUTO_RESPONSE_SUFFIX = /\n\n## AUTO-RESPONSE[\s\S]*$/;
const userText = (stored: string): string => stored.replace(AUTO_RESPONSE_SUFFIX, '');

/** Real conversations as benchmark conversations; the owner's own QA probes never enter a KPI. */
export function loadRealHistory(): LoadedRealHistory {
  const { records, checksum: corpusChecksum } = loadCorpus();
  const { labels, checksum: labelsChecksum } = loadLabels();
  const splitText = readText('split.json');
  const split = Split.parse(JSON.parse(splitText));
  if (split.corpusChecksum !== corpusChecksum) throw new Error('split.json was made for another corpus');
  const side = new Map<string, 'dev' | 'heldout'>();
  for (const id of split.dev) side.set(id, 'dev');
  for (const id of split.heldout) side.set(id, 'heldout');
  const dev: Conversation[] = [];
  const heldout: Conversation[] = [];
  for (const record of records) {
    if (record.flags.qaProbe) continue;
    const label = labels.get(record.id);
    const where = side.get(record.id);
    if (!label || !where) throw new Error(`${record.id} has no label or split side`);
    const conversation = ConversationSchema.parse({
      id: record.id,
      lang: record.lang,
      chat: record.chat,
      tz: record.tz,
      clock: record.clock,
      date: record.date,
      world: 'empty',
      ...(seedEventsOf(label) ? { seedEvents: seedEventsOf(label) } : {}),
      say: userText(record.say),
      expect: label.expect,
      real: { user: record.user, status: label.status, historical: label.historical, qaProbe: false },
    }) as Conversation;
    (where === 'dev' ? dev : heldout).push(conversation);
  }
  return {
    version: 1,
    checksum: sha256(`${corpusChecksum}:${labelsChecksum}:${splitText}`),
    dev,
    heldout,
    labelsChecksum,
    splitChecksum: sha256(splitText),
    corpusChecksum,
    excludedQaProbes: records.filter((record) => record.flags.qaProbe).length,
  };
}

if (import.meta.main) {
  const split = writeSplit();
  console.log(`split written: dev ${split.dev.length}, held-out ${split.heldout.length} (${split.heldoutShare})`);
}
