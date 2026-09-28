// Stops an intent run whose rule changed while it ran, and tells the user what a stopped run
// did. Code that executes a matched intent workflow dispatches its tools through guardRuleTools,
// keyed by the rule identity read together with the workflow it runs
// (IntentRepository.runnableFingerprint). The check runs right before each call: a call whose
// check ran before an approval committed completes; every later call is refused with
// mutationState 'not_applied', so it adds no write evidence.
import { t, toLang } from '../../config/constants.ts';
import type { ToolResult } from '../ai/types.ts';
import type { MutationEvidence } from './intent-executor.ts';

export type RunTools = (toolName: string, input: unknown) => ToolResult | Promise<ToolResult>;

interface RuleIdentitySource {
  currentRuleFingerprint(intentId: number): string | null;
}

export interface RuleRunGuard {
  run: RunTools;
  /** True once any call observed the change; steps that call no tool never re-check. */
  changed(): boolean;
}

export function guardRuleTools(
  source: RuleIdentitySource,
  intentId: number,
  fingerprint: string,
  tools: RunTools,
): RuleRunGuard {
  let ruleChanged = false;
  const run: RunTools = (name, input) => {
    if (ruleChanged || source.currentRuleFingerprint(intentId) !== fingerprint) {
      ruleChanged = true;
      return { success: false, error: 'INTENT_RULE_CHANGED', mutationState: 'not_applied' };
    }
    return tools(name, input);
  };
  return { run, changed: () => ruleChanged };
}

/**
 * What the user is told when a run stops. A failed run must never replay the user's request
 * through the AI once a write may have happened, and never claims "nothing changed" then.
 */
export function evidenceMessage(language: string, evidence: MutationEvidence | undefined): string {
  const messages = t(toLang(language)).intentWorkflow;
  if (evidence === 'applied') return messages.appliedIncomplete;
  if (evidence === 'unknown') return messages.outcomeUnknown;
  return messages.failedUnchanged;
}
