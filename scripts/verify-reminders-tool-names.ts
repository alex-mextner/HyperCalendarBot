
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import { remindersIntents } from './seed-intents-reminders.ts';

const names = new Set(getToolDefinitions().map((t) => t.function.name));
console.log('total real tool names:', names.size);

const RESERVED = new Set(['respond', 'ask_user']);

function collectCalls(workflow: any): string[] {
  const calls: string[] = [];
  if (workflow.tools) {
    for (const t of workflow.tools) calls.push(t.name);
  }
  if (workflow.steps) {
    for (const s of workflow.steps) {
      if (s.call) calls.push(s.call);
    }
  }
  return calls;
}

let ok = true;
for (const intent of remindersIntents) {
  const calls = collectCalls(intent.workflow as any);
  for (const c of calls) {
    if (!RESERVED.has(c) && !names.has(c)) {
      ok = false;
      console.log(`[UNKNOWN TOOL] ${intent.canonical_name}: "${c}" is not a real tool name`);
    }
  }
}
console.log(ok ? 'ALL TOOL NAMES VALID' : 'TOOL NAME FAILURES');
