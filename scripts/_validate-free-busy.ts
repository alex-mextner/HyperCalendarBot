// Throwaway structural validator — not part of the deliverable, deleted after use.
import { freeBusyIntents } from './seed-intents-free-busy.ts';
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { validateWorkflowVariables } from '../src/services/intent/workflow-validator.ts';

const realToolNames = new Set(getToolDefinitions().map((t) => t.function.name));
realToolNames.add('respond');
realToolNames.add('ask_user');

let ok = true;
const seen = new Set<string>();

for (const intent of freeBusyIntents) {
  const label = intent.canonical_name;
  if (seen.has(label)) {
    console.log(`❌ ${label}: duplicate canonical_name within this file`);
    ok = false;
  }
  seen.add(label);

  // 1. WorkflowSchema shape
  const parsed = WorkflowSchema.safeParse(intent.workflow);
  if (!parsed.success) {
    console.log(`❌ ${label}: WorkflowSchema failed —`, JSON.stringify(parsed.error.issues));
    ok = false;
    continue;
  }

  // 2. Every tool/call name is real
  const calls: string[] = [];
  if ('tools' in parsed.data) {
    calls.push(...parsed.data.tools.map((t) => t.name));
  } else {
    calls.push(...parsed.data.steps.filter((s) => s.call !== undefined).map((s) => s.call!));
  }
  for (const c of calls) {
    if (!realToolNames.has(c)) {
      console.log(`❌ ${label}: unknown tool/call "${c}"`);
      ok = false;
    }
  }

  // 3. Regex compiles
  try {
    new RegExp(intent.pattern, 'i');
  } catch (e) {
    console.log(`❌ ${label}: pattern does not compile — ${String(e)}`);
    ok = false;
  }

  // 4. Variable/template validation (the real function used by the learner pipeline)
  const errors = validateWorkflowVariables(parsed.data, intent.pattern);
  if (errors.length > 0) {
    console.log(`❌ ${label}: variable errors —`);
    for (const e of errors) console.log(`    - ${e}`);
    ok = false;
  }

  // 5. trigger_words required whenever pattern is present (matcher.load() skips pattern otherwise)
  if (intent.pattern && intent.trigger_words.length === 0) {
    console.log(`❌ ${label}: pattern set but trigger_words is empty`);
    ok = false;
  }

  if (parsed.success && errors.length === 0 && calls.every((c) => realToolNames.has(c))) {
    console.log(`✅ ${label}`);
  }
}

console.log(ok ? '\nALL PASS' : '\nFAILURES ABOVE');
process.exit(ok ? 0 : 1);
