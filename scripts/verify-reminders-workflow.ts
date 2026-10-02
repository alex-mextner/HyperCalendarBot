import { resolveVariables } from '../src/services/intent/variable-resolver.ts';
import { evaluate } from '../src/services/intent/expression-evaluator.ts';
import { handleCalculate } from '../src/services/ai/tool-handlers/calculate.ts';

interface StubUserContext {
  timezone: string;
  language: 'ru' | 'en';
  username: string;
  firstName: string;
  userId: number;
  groupIsGroup: boolean;
}

const userCtx: StubUserContext = {
  timezone: 'Europe/Belgrade',
  language: 'ru',
  username: 'x',
  firstName: 'X',
  userId: 1,
  groupIsGroup: false,
};
const stepResults: Record<string, unknown> = { tool_outputs: { found: [{ id: 42, title: 'Standup' }] } };
const emptyStepResults: Record<string, unknown> = { tool_outputs: { found: [] } };

const resolved = resolveVariables('{{tool_outputs.found.0.id}}', {}, userCtx, stepResults);
console.log('resolved type/value:', typeof resolved, resolved);

console.log('when true:', evaluate('tool_outputs.found.length > 0', stepResults));
console.log('when false:', evaluate('tool_outputs.found.length > 0', emptyStepResults));

console.log(handleCalculate({ expression: '2026-09-08T15:04:05+03:00 + 60min' }));
console.log(handleCalculate({ expression: '2026-09-08T23:50:00+03:00 + 60min' }));
console.log(handleCalculate({ expression: '2026-09-08T15:04:05+03:00 + 45min' }));
