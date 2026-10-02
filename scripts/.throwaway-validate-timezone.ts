
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { IntentExecutor } from '../src/services/intent/intent-executor.ts';
import { formatResponse } from '../src/services/intent/response-formatter.ts';
import { handleGetTimezoneInfoWithCityFallback } from '../src/services/ai/tool-handlers/timezone.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { validateWorkflowVariables } from '../src/services/intent/workflow-validator.ts';
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import { timezoneIntents } from './seed-intents-timezone.ts';

const toolNames = new Set([...getToolDefinitions('live_call'), ...getToolDefinitions()].map((t) => t.function.name));

let allOk = true;
const canonicalNames = new Set();
function collectCalls(workflow) {
  const calls = [];
  if (Array.isArray(workflow.tools)) for (const t of workflow.tools) calls.push(t.name);
  if (Array.isArray(workflow.steps)) for (const s of workflow.steps) {
    if (s.call && s.call !== 'respond' && s.call !== 'ask_user') calls.push(s.call);
  }
  return calls;
}

console.log('=== STRUCTURAL VALIDATION ===');
for (const intent of timezoneIntents) {
  if (canonicalNames.has(intent.canonical_name)) { allOk = false; console.log('DUP NAME', intent.canonical_name); }
  canonicalNames.add(intent.canonical_name);
  const parsed = WorkflowSchema.safeParse(intent.workflow);
  if (!parsed.success) { allOk = false; console.log(intent.canonical_name, 'SCHEMA FAIL', JSON.stringify(parsed.error.issues)); continue; }
  const varErrors = validateWorkflowVariables(parsed.data, intent.pattern);
  if (varErrors.length) { allOk = false; console.log(intent.canonical_name, 'VAR ERRORS', varErrors); }
  const calls = collectCalls(intent.workflow);
  for (const c of calls) if (!toolNames.has(c)) { allOk = false; console.log(intent.canonical_name, 'UNKNOWN TOOL', c); }
  if (intent.pattern) { try { new RegExp(intent.pattern, 'i'); } catch (e) { allOk = false; console.log(intent.canonical_name, 'REGEX FAIL', String(e)); } }
}
console.log(allOk ? 'STRUCTURAL: ALL PASS' : 'STRUCTURAL: FAILURES');

console.log('\n=== MATCH + EXECUTE SIMULATION ===');
const fakeIntents = timezoneIntents.map((it, idx) => ({
  id: idx + 1,
  canonical_name: it.canonical_name,
  phrases: JSON.stringify(it.phrases),
  trigger_words: JSON.stringify(it.trigger_words),
  pattern: it.pattern,
  workflow: JSON.stringify(it.workflow),
  format: it.format ?? 'text',
  status: 'approved',
}));

const matcher = new IntentMatcher();
matcher.load(fakeIntents);

const userCtx = { timezone: 'Europe/Moscow', language: 'ru', username: 'test', firstName: 'Test', userId: 1, groupIsGroup: false, groupChatId: undefined };
const executor = new IntentExecutor();
async function executeTool(name, input) {
  if (name === 'get_timezone_info') return await handleGetTimezoneInfoWithCityFallback(input);
  throw new Error('unexpected tool ' + name);
}

const testCases = [
  { msg: 'сколько сейчас времени в Лондоне', expect: 'current_time_in_city' },
  { msg: 'what time is it in Tokyo', expect: 'current_time_in_city' },
  { msg: 'который час в Нью-Йорке', expect: 'current_time_in_city' },
  { msg: 'какое время в Париже', expect: 'current_time_in_city' },
  { msg: 'time in Dubai', expect: 'current_time_in_city' },
  { msg: 'переведи 15:00 в Лондон', expect: 'convert_my_time_to_city' },
  { msg: 'convert 9 to Tokyo', expect: 'convert_my_time_to_city' },
  { msg: 'переведи 9 в часовой пояс Парижа', expect: 'convert_my_time_to_city' },
  { msg: 'какой у меня часовой пояс', expect: 'current_timezone_setting' },
  { msg: "what's my timezone", expect: 'current_timezone_setting' },
  { msg: 'мировые часы', expect: 'world_clock_common_cities' },
  { msg: 'список часовых поясов', expect: 'list_common_timezone_shortcuts' },
  { msg: 'сколько сейчас времени', expect: 'time_now_own_timezone' },
  { msg: 'который час', expect: 'time_now_own_timezone' },
  { msg: 'what time is it', expect: 'time_now_own_timezone' },
];

for (const tc of testCases) {
  const result = matcher.match(tc.msg);
  if (!result) { console.log('NO MATCH:', tc.msg, '(expected', tc.expect + ')'); allOk = false; continue; }
  const row = fakeIntents[result.intentId - 1];
  const ok = row.canonical_name === tc.expect;
  if (!ok) allOk = false;
  console.log(`"${tc.msg}" -> ${row.canonical_name} ${ok ? 'OK' : 'MISMATCH expected ' + tc.expect}`, JSON.stringify(result.captures));
  const workflow = JSON.parse(row.workflow);
  try {
    const execResult = await executor.run(workflow, result.captures, userCtx, executeTool);
    if (execResult.response) {
      const formatted = formatResponse(row.format, execResult.response, userCtx.timezone, userCtx.language);
      console.log('  ->', formatted);
    } else {
      console.log('  EXEC EMPTY RESPONSE', JSON.stringify(execResult));
      allOk = false;
    }
  } catch (e) {
    console.log('  EXEC THREW:', String(e));
    allOk = false;
  }
}

console.log('\n\nFINAL:', allOk ? 'ALL PASS' : 'FAILURES PRESENT');
process.exit(allOk ? 0 : 1);
