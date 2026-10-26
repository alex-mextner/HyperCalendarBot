// Merges two independent annotations of the real-history corpus into labels.jsonl. Where both annotators agree the
// label is kept; every disagreement is listed for a human decision and is never settled by the parser under test.
//   bun --no-env-file scripts/intent-benchmark/reconcile-labels.ts A.jsonl B.jsonl [A2.jsonl B2.jsonl ...] \
//        --adjudicated FILE.jsonl --out docs/intents/real-history/labels.jsonl --agreement docs/intents/real-history/labels-agreement.json
// Files are paired in the order given. The adjudication file holds one final label per disputed id (same line format).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AI_REASONS, type FamilyId, FamilySlots, SeedEventSchema } from './history.ts';

export const Label = z.strictObject({
  id: z.string().regex(/^rh-\d{4}$/),
  expect: z.union([
    z.strictObject({ route: z.literal('ai'), why: z.string(), intentLike: z.boolean() }),
    z.strictObject({
      route: z.literal('rule'),
      family: z.enum(Object.keys(FamilySlots) as [string, ...string[]]),
      slots: z.record(z.string(), z.unknown()),
      confirm: z.enum(['yes', 'no']).optional(),
    }),
  ]),
  seedEvents: z.array(SeedEventSchema).max(6).optional(),
  status: z.enum(['confirmed', 'unclear']),
  historical: z.enum(['agrees', 'disagrees', 'unclear', 'none']),
  note: z.string().max(240),
  /** `agreed`: both annotators gave the same route/family/slots; `adjudicated`: a person settled a disagreement. */
  basis: z.enum(['agreed', 'adjudicated']).optional(),
});
export type LabelLine = z.infer<typeof Label>;

const fold = (text: unknown): string =>
  String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/** Same decision: both AI, or the same family with the same slots (titles compared folded; alternates ignored). */
export function sameDecision(a: LabelLine, b: LabelLine): boolean {
  if (a.expect.route !== b.expect.route) return false;
  if (a.expect.route === 'ai' || b.expect.route === 'ai') return true;
  if (a.expect.family !== b.expect.family) return false;
  const folded = (value: unknown): unknown =>
    typeof value === 'string'
      ? fold(value)
      : Array.isArray(value)
        ? value.map(folded)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([x], [y]) => x.localeCompare(y))
                .map(([name, item]) => [name, folded(item)]),
            )
          : value;
  const key = (slots: { [k: string]: unknown }) =>
    JSON.stringify(folded(Object.fromEntries(Object.entries(slots).filter(([name]) => name !== 'titleAlt'))));
  return key(a.expect.slots) === key(b.expect.slots);
}

/** The label's slots and reason must be exactly what the benchmark's own schema accepts for that family. */
export function assertConforms(label: LabelLine): void {
  if (label.expect.route === 'ai') {
    if (!(AI_REASONS as readonly string[]).includes(label.expect.why))
      throw new Error(`${label.id}: unknown AI reason ${label.expect.why}`);
    return;
  }
  FamilySlots[label.expect.family as FamilyId].parse(label.expect.slots);
}

export const readLabels = (path: string): LabelLine[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const label = Label.parse(JSON.parse(line));
      assertConforms(label);
      return label;
    });

type RouteClass = 'rule' | 'ai' | 'unclear';
const routeClass = (label: LabelLine): RouteClass => (label.status === 'unclear' ? 'unclear' : label.expect.route);

/** Cohen's kappa over the three route classes; null when chance agreement is total. */
export function cohenKappa(pairs: ReadonlyArray<readonly [RouteClass, RouteClass]>): number | null {
  const classes: RouteClass[] = ['rule', 'ai', 'unclear'];
  const n = pairs.length;
  if (n === 0) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const expected = classes.reduce(
    (sum, c) => sum + (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n),
    0,
  );
  return expected === 1 ? null : (observed - expected) / (1 - expected);
}

export interface Agreement {
  pairs: number;
  kappaRoute: number | null;
  routeAgreement: number;
  bothRule: number;
  sameFamily: number;
  sameSlots: number;
}

export function agreementOf(a: readonly LabelLine[], b: readonly LabelLine[]): Agreement {
  const routes = a.map((label, index) => [routeClass(label), routeClass(b[index] as LabelLine)] as const);
  let bothRule = 0;
  let sameFamily = 0;
  let sameSlots = 0;
  for (const [index, left] of a.entries()) {
    const right = b[index] as LabelLine;
    if (left.expect.route !== 'rule' || right.expect.route !== 'rule') continue;
    bothRule++;
    if (left.expect.family !== right.expect.family) continue;
    sameFamily++;
    if (sameDecision(left, right)) sameSlots++;
  }
  return {
    pairs: a.length,
    kappaRoute: cohenKappa(routes),
    routeAgreement: routes.filter(([x, y]) => x === y).length / Math.max(1, routes.length),
    bothRule,
    sameFamily,
    sameSlots,
  };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      adjudicated: { type: 'string' },
      out: { type: 'string' },
      agreement: { type: 'string' },
      validate: { type: 'boolean', default: false },
    },
  });
  if (values.validate) {
    for (const file of positionals) console.log(`${file}: ${readLabels(file).length} valid lines`);
    process.exit(0);
  }
  if (positionals.length === 0 || positionals.length % 2 !== 0) throw new Error('pass annotation files in A/B pairs');
  const adjudicated = new Map(
    (values.adjudicated ? readLabels(values.adjudicated) : []).map((label) => [label.id, label]),
  );
  const merged: LabelLine[] = [];
  const disputed: Array<{ a: LabelLine; b: LabelLine }> = [];
  let both = 0;
  const allFirst: LabelLine[] = [];
  const allSecond: LabelLine[] = [];
  const perPair: Agreement[] = [];
  for (let index = 0; index < positionals.length; index += 2) {
    const first = readLabels(positionals[index] as string);
    const second = readLabels(positionals[index + 1] as string);
    if (first.length !== second.length) throw new Error(`pair ${index / 2} differs in length`);
    perPair.push(agreementOf(first, second));
    allFirst.push(...first);
    allSecond.push(...second);
    for (const [row, a] of first.entries()) {
      const b = second[row] as LabelLine;
      if (a.id !== b.id) throw new Error(`pair ${index / 2} line ${row}: ids differ ${a.id} ${b.id}`);
      both++;
      const final = adjudicated.get(a.id);
      if (final) merged.push({ ...final, basis: 'adjudicated' });
      else if (sameDecision(a, b)) {
        const unclear = a.status === 'unclear' || b.status === 'unclear';
        merged.push({
          ...a,
          status: unclear ? 'unclear' : 'confirmed',
          historical: a.historical === b.historical ? a.historical : 'unclear',
          basis: 'agreed',
        });
      } else disputed.push({ a, b });
    }
  }
  if (disputed.length > 0) {
    for (const { a, b } of disputed)
      console.log(`DISPUTE ${a.id}\n  A ${JSON.stringify(a.expect)}\n  B ${JSON.stringify(b.expect)}`);
    console.error(`${disputed.length} disputed of ${both}; write them to an adjudication file and pass --adjudicated`);
    process.exit(2);
  }
  merged.sort((x, y) => x.id.localeCompare(y.id));
  if (values.out) writeFileSync(values.out, `${merged.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const adjudicatedCount = merged.filter((line) => line.basis === 'adjudicated').length;
  const summary = {
    records: merged.length,
    agreedBeforeAdjudication: both - adjudicatedCount - disputed.length,
    adjudicated: adjudicatedCount,
    rawAgreementRate: (both - adjudicatedCount) / both,
    annotators:
      'two independent annotators per chunk; every disagreement settled by a stated rule or a person; any unclear mark makes the label unclear (excluded from precision claims, kept for coverage analysis)',
    agreementOverall: agreementOf(allFirst, allSecond),
    agreementPerChunk: perPair,
    unclear: merged.filter((line) => line.status === 'unclear').length,
  };
  if (values.agreement) writeFileSync(values.agreement, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(summary);
}
