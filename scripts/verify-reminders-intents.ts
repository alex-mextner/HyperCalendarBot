
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { validateWorkflowVariables } from '../src/services/intent/workflow-validator.ts';
import { remindersIntents } from './seed-intents-reminders.ts';

let allOk = true;
console.log('total intents:', remindersIntents.length);
for (const intent of remindersIntents) {
  const parsed = WorkflowSchema.safeParse(intent.workflow);
  if (!parsed.success) {
    allOk = false;
    console.log(`[SCHEMA FAIL] ${intent.canonical_name}:`, JSON.stringify(parsed.error.issues));
    continue;
  }
  const varErrors = validateWorkflowVariables(parsed.data, intent.pattern);
  if (varErrors.length > 0) {
    allOk = false;
    console.log(`[VAR FAIL] ${intent.canonical_name}:`, varErrors);
  } else {
    console.log(`[OK] ${intent.canonical_name}`);
  }
  try {
    new RegExp(intent.pattern, 'i');
  } catch (e) {
    allOk = false;
    console.log(`[REGEX FAIL] ${intent.canonical_name}:`, String(e));
  }
  // canonical_name uniqueness within this file
}
const names = remindersIntents.map((i) => i.canonical_name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) {
  allOk = false;
  console.log('[DUPLICATE NAMES]', dupes);
}
console.log(allOk ? '\nALL PASS' : '\nFAILURES PRESENT');
