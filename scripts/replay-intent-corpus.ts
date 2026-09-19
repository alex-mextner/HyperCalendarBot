// Read-only, no tool execution and no message/capture output. Input is a private local archive.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import type { Intent } from '../src/database/types.ts';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { seedFingerprint } from '../src/services/intent/seed-replacement.ts';
import { evaluateBindings } from '../src/services/intent/workflow-bindings.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';

const { values } = parseArgs({ args: process.argv.slice(2), options: { input: { type: 'string' } }, strict: true });
if (!values.input) throw new Error('--input private JSON archive is required');
const raw = readFileSync(values.input, 'utf8');
if (raw.length > 20_000_000) throw new Error('Corpus too large');
const records = z
  .array(z.object({ identity: z.string(), text: z.string(), createdAt: z.string(), timezone: z.string() }))
  .max(100000)
  .parse(JSON.parse(raw));
const rows = seedIntents.map((s, i) => ({
  ...s,
  id: i + 1,
  workflow: JSON.stringify(s.workflow),
  phrases: JSON.stringify(s.phrases),
  trigger_words: JSON.stringify(s.trigger_words),
  status: 'approved',
  format: 'text',
  created_at: '2000-01-01 00:00:00',
})) as Intent[];
const matcher = new IntentMatcher();
matcher.load(rows);
const counts = {
  examined: 0,
  oversized: 0,
  matched: 0,
  ambiguous: 0,
  abstained: 0,
  bindingsValid: 0,
  bindingsRejected: 0,
};
const families: { [name: string]: { matched: number; bindingsValid: number; bindingsRejected: number } } = {};
for (const record of records) {
  if (record.text.length > 16000) {
    counts.oversized++;
    continue;
  }
  counts.examined++;
  const decision = matcher.explain(record.text);
  if (decision.kind === 'abstain' && decision.reason === 'ambiguous') {
    counts.ambiguous++;
    continue;
  }
  if (decision.kind !== 'matched') {
    counts.abstained++;
    continue;
  }
  counts.matched++;
  const definition = seedIntents[decision.result.intentId - 1]!;
  families[definition.canonical_name] ??= { matched: 0, bindingsValid: 0, bindingsRejected: 0 };
  const entry = families[definition.canonical_name]!;
  entry.matched++;
  try {
    const workflow = WorkflowSchema.parse(definition.workflow);
    const date = new Date(record.createdAt.includes('T') ? record.createdAt : `${record.createdAt.replace(' ', 'T')}Z`);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid historical time');
    evaluateBindings(
      'bindings' in workflow ? (workflow.bindings ?? {}) : {},
      decision.result.captures,
      { userId: 0, timezone: record.timezone, language: 'ru' },
      workflow.i18n,
      date,
    );
    counts.bindingsValid++;
    entry.bindingsValid++;
  } catch {
    counts.bindingsRejected++;
    entry.bindingsRejected++;
  }
}
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      sourceFingerprint: seedFingerprint(seedIntents),
      sourceRuleCount: seedIntents.length,
      retainedUtterances: records.length,
      ...counts,
      families,
      sideEffects: 0,
      interpretation:
        'Syntactic routing and binding replay only; not measured accuracy, action success, or independent gold labels. Historical timezone is an explicit input assumption.',
    },
    null,
    2,
  ),
);
