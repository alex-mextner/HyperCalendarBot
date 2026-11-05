// Rules as the matcher sees them: approved rows numbered in order, the same numbering the
// simulator's database gets when it inserts them. Shared by the simulator and by the harness's
// matcher-only column, which routes every case (including ones never simulated) without a clock.
import type { Intent } from '../../../database/types.ts';
import { IntentMatcher } from '../intent-matcher.ts';
import type { CanonicalSeed } from '../seed-replacement.ts';

export function ruleRows(rules: readonly CanonicalSeed[]): Intent[] {
  return rules.map((rule, index) => ({
    id: index + 1,
    canonical_name: rule.canonical_name,
    phrases: JSON.stringify(rule.phrases),
    trigger_words: JSON.stringify(rule.trigger_words),
    pattern: rule.pattern,
    workflow: JSON.stringify(rule.workflow),
    format: 'text',
    status: 'approved',
    source_message: rule.source_message,
    created_at: '2000-01-01 00:00:00',
  }));
}

export interface RuleRouter {
  matcher: IntentMatcher;
  /** Canonical name of a rule by the id the matcher reports. */
  nameOf(intentId: number): string;
}

export function ruleRouter(rules: readonly CanonicalSeed[]): RuleRouter {
  const rows = ruleRows(rules);
  const matcher = new IntentMatcher();
  matcher.load(rows);
  return {
    matcher,
    nameOf(intentId) {
      const row = rows[intentId - 1];
      if (!row) throw new Error(`Matcher reported unknown rule id ${intentId}`);
      return row.canonical_name;
    },
  };
}
