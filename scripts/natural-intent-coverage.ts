/**
 * Offline coverage of the canonical basis over a private, sanitized corpus of recorded
 * requests. Each request is matched and its typed bindings are evaluated at the request's
 * own recorded time in the stated timezone assumption. No tool runs and no database is
 * opened. Only counts, case ids and reasons are printed — never request text.
 *
 *   bun scripts/natural-intent-coverage.ts <semantic-cases.json>
 */
import { z } from 'zod';
import type { Intent } from '../src/database/types.ts';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { recognizeCancelTarget, recognizeEventEntry } from '../src/services/intent/natural-entry.ts';
import { canonicalMetadata, seedIntents } from '../src/services/intent/seed-catalog.ts';
import { evaluateBindings } from '../src/services/intent/workflow-bindings.ts';
import { WorkflowInputError } from '../src/services/intent/workflow-input.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { jsonCodec } from '../src/utils/json-codec.ts';

const Case = z.object({
  caseId: z.string().max(64),
  request: z.string().max(20000),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
  timezoneAssumption: z.string().max(64),
  sensitiveExcluded: z.boolean(),
});
const Corpus = jsonCodec(z.array(z.looseObject(Case.shape)).max(5000));

function rows(): Intent[] {
  return seedIntents.map((seed, index) => ({
    id: index + 1,
    canonical_name: seed.canonical_name,
    phrases: JSON.stringify(seed.phrases),
    trigger_words: JSON.stringify(seed.trigger_words),
    pattern: seed.pattern,
    workflow: JSON.stringify(seed.workflow),
    format: 'text',
    status: 'approved',
    source_message: seed.source_message,
    created_at: '',
  }));
}

type Outcome =
  | { bucket: 'excluded'; reason: string }
  | { bucket: 'matched'; family: string; result: string }
  | { bucket: 'abstained'; reason: string };

/** Why a message was excluded from the natural-phrase denominator, or null when it counts. */
function exclusion(item: z.infer<typeof Case>): string | null {
  if (item.sensitiveExcluded) return 'sensitive_redacted';
  const text = item.request.trim();
  if (!text) return 'empty';
  if (text.startsWith('[User picker result]')) return 'bot_picker_result';
  if (text.startsWith('[Group:')) return 'group_metadata';
  if (text.startsWith('📨 Invitation from')) return 'forwarded_bot_invitation';
  return null;
}

/** "confirmation": the workflow will ask yes/cancel; "clarification": it asks for a missing value. */
function bindingResult(family: string, captures: { [key: string]: string }, item: z.infer<typeof Case>): string {
  const index = seedIntents.findIndex((seed) => seed.canonical_name === family);
  const workflow = WorkflowSchema.parse(seedIntents[index]!.workflow);
  if (workflow.version !== 2 || !('bindings' in workflow) || !workflow.bindings) return 'valid_no_bindings';
  const now = new Date(`${item.createdAt.replace(' ', 'T')}Z`);
  const ctx = { timezone: item.timezoneAssumption, language: 'ru' };
  try {
    const bound = evaluateBindings(workflow.bindings, captures, ctx, workflow.i18n, now);
    const entry = bound.entry;
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'mode' in entry)
      return entry.mode === 'choose' ? 'valid_clarification_clock' : `valid_confirmation_${String(entry.mode)}`;
    const risk = canonicalMetadata[index]!.risk;
    return risk === 'write' || risk === 'sensitive_write' ? 'valid_confirmation' : 'valid_read';
  } catch (error) {
    if (error instanceof WorkflowInputError) return `binding_rejected_${error.code}`;
    throw error;
  }
}

function classify(matcher: IntentMatcher, item: z.infer<typeof Case>): Outcome {
  const excluded = exclusion(item);
  if (excluded) return { bucket: 'excluded', reason: excluded };
  const decision = matcher.explain(item.request);
  if (decision.kind === 'matched') {
    const family = seedIntents[decision.result.intentId - 1]!.canonical_name;
    return { bucket: 'matched', family, result: bindingResult(family, decision.result.captures, item) };
  }
  const entry = recognizeEventEntry(item.request);
  const cancel = recognizeCancelTarget(item.request);
  const detail = entry.kind === 'abstain' ? entry.reason : 'entry';
  const cancelDetail = cancel.kind === 'abstain' ? cancel.reason : 'target';
  return { bucket: 'abstained', reason: `${decision.reason} (entry:${detail}, cancel:${cancelDetail})` };
}

function tally(outcomes: [string, Outcome][], key: (outcome: Outcome) => string | null): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [caseId, outcome] of outcomes) {
    const name = key(outcome);
    if (name === null) continue;
    groups.set(name, [...(groups.get(name) ?? []), caseId]);
  }
  return new Map([...groups].sort((a, b) => b[1].length - a[1].length));
}

function print(title: string, groups: Map<string, string[]>, withIds: boolean): void {
  console.log(`\n## ${title}`);
  for (const [name, ids] of groups)
    console.log(`${String(ids.length).padStart(4)}  ${name}${withIds ? `  [${ids.join(' ')}]` : ''}`);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error('usage: bun scripts/natural-intent-coverage.ts <semantic-cases.json>');
  const parsed = Corpus.safeParse(await Bun.file(path).text());
  if (!parsed.success) throw new Error('Corpus does not match the expected shape');
  const matcher = new IntentMatcher();
  matcher.load(rows());
  const outcomes: [string, Outcome][] = parsed.data.map((item) => [
    item.caseId.replace(/^case-/, ''),
    classify(matcher, item),
  ]);
  const counted = outcomes.filter(([, outcome]) => outcome.bucket !== 'excluded');
  const matched = counted.filter(([, outcome]) => outcome.bucket === 'matched');
  const valid = matched.filter(([, outcome]) => outcome.bucket === 'matched' && outcome.result.startsWith('valid'));
  console.log(`cases: ${outcomes.length}, natural denominator: ${counted.length}`);
  console.log(`matched: ${matched.length}, matched with valid bindings: ${valid.length}`);
  console.log(`valid share of denominator: ${((valid.length / Math.max(counted.length, 1)) * 100).toFixed(1)}%`);
  print(
    'excluded from denominator',
    tally(outcomes, (o) => (o.bucket === 'excluded' ? o.reason : null)),
    false,
  );
  print(
    'matched by family',
    tally(outcomes, (o) => (o.bucket === 'matched' ? o.family : null)),
    true,
  );
  print(
    'binding result',
    tally(outcomes, (o) => (o.bucket === 'matched' ? o.result : null)),
    true,
  );
  print(
    'abstained',
    tally(outcomes, (o) => (o.bucket === 'abstained' ? o.reason : null)),
    true,
  );
}

await main();
