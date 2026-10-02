
import { Database } from 'bun:sqlite';
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { timezoneIntents } from './seed-intents-timezone.ts';

const db = new Database('data/calendar.db', { readonly: true });
const existing = db.query("SELECT id, canonical_name, phrases, trigger_words, pattern, workflow, format FROM intents WHERE status='approved'").all();
db.close();

const maxId = Math.max(...existing.map((r) => r.id));
const newRows = timezoneIntents.map((it, idx) => ({
  id: maxId + idx + 1,
  canonical_name: it.canonical_name,
  phrases: JSON.stringify(it.phrases),
  trigger_words: JSON.stringify(it.trigger_words),
  pattern: it.pattern,
  workflow: JSON.stringify(it.workflow),
  format: it.format ?? 'text',
}));

const all = [...existing, ...newRows];
const matcher = new IntentMatcher();
matcher.load(all);

// 1. Existing intents' own phrases must still resolve to themselves (no regression from new additions)
console.log('=== EXISTING INTENTS STILL SELF-MATCH ===');
let ok = true;
for (const row of existing) {
  const phrases = JSON.parse(row.phrases);
  for (const p of phrases) {
    const res = matcher.match(p);
    const gotName = res ? all.find((r) => r.id === res.intentId)?.canonical_name : null;
    if (gotName !== row.canonical_name) {
      ok = false;
      console.log('REGRESSION:', JSON.stringify(p), '-> expected', row.canonical_name, 'got', gotName);
    }
  }
}
console.log(ok ? 'no regressions' : 'REGRESSIONS FOUND');

// 2. New intents' phrases must resolve to themselves, not hijacked by existing intents
console.log('\n=== NEW INTENTS SELF-MATCH AGAINST FULL SET ===');
ok = true;
for (const it of timezoneIntents) {
  for (const p of it.phrases) {
    const res = matcher.match(p);
    const gotName = res ? all.find((r) => r.id === res.intentId)?.canonical_name : null;
    if (gotName !== it.canonical_name) {
      ok = false;
      console.log('MISMATCH:', JSON.stringify(p), '-> expected', it.canonical_name, 'got', gotName);
    }
  }
}
console.log(ok ? 'all new intents self-match correctly' : 'MISMATCHES FOUND');

// 3. Cross-check: none of the existing 16 approved intents' trigger_words overlap
// with any of my new intents' trigger_words in a way that causes false positives —
// probe each existing intent's example phrases against a matcher containing ONLY
// my 6 new rows (isolate whether my patterns would misfire on existing traffic).
console.log('\n=== ISOLATED: do my patterns misfire on EXISTING approved phrases? ===');
const onlyNew = new IntentMatcher();
onlyNew.load(newRows);
ok = true;
for (const row of existing) {
  const phrases = JSON.parse(row.phrases);
  for (const p of phrases) {
    const res = onlyNew.match(p);
    if (res) {
      ok = false;
      const gotName = newRows.find((r) => r.id === res.intentId)?.canonical_name;
      console.log('FALSE POSITIVE:', JSON.stringify(p), '(belongs to', row.canonical_name + ')', '-> my intent', gotName);
    }
  }
}
console.log(ok ? 'no false positives' : 'FALSE POSITIVES FOUND');
