
import { IntentExecutor } from '../src/services/intent/intent-executor.ts';
import { remindersIntents } from './seed-intents-reminders.ts';
import type { ToolResult } from '../src/services/ai/types.ts';

const byName = Object.fromEntries(remindersIntents.map((i) => [i.canonical_name, i]));

const userCtx = {
  timezone: 'Europe/Belgrade',
  language: 'ru' as const,
  username: 'ultra',
  firstName: 'Ultra',
  userId: 1,
  groupIsGroup: false,
};

const executor = new IntentExecutor();

type Call = { tool: string; input: unknown };

function makeExecuteTool(responses: Record<string, ToolResult | ((input: unknown) => ToolResult)>, calls: Call[]) {
  return async (toolName: string, input: unknown): Promise<ToolResult> => {
    calls.push({ tool: toolName, input });
    const r = responses[toolName];
    if (!r) return { success: false, error: `no stub for ${toolName}` };
    return typeof r === 'function' ? r(input) : r;
  };
}

async function run(name: string, captures: Record<string, string>, responses: Record<string, ToolResult | ((input: unknown) => ToolResult)>) {
  const calls: Call[] = [];
  const exec = makeExecuteTool(responses, calls);
  const intent = byName[name];
  const result = await executor.run(intent.workflow as any, captures, userCtx, exec);
  console.log(`\n=== ${name} captures=${JSON.stringify(captures)} ===`);
  console.log('response:', result.response);
  for (const c of calls) console.log('  call:', c.tool, JSON.stringify(c.input));
  return { result, calls };
}

async function main() {
  // 1. reminders_for_event
  await run('reminders_for_event', { $1: 'стендап' }, {
    get_reminders: { success: true, output: '"Стендап" (id:5): за 15 минут' },
  });

  // 2. remind_minutes_before_event — found, not all-day
  await run('remind_minutes_before_event', { $1: '15', $2: 'стендап' }, {
    search_events: {
      success: true,
      output: 'id: 99, title: Standup, start: 2026-09-10T10:00:00Z',
      data: [{ id: 99, title: 'Standup', date: '2026-09-10', time: '10:00', all_day: false }],
    },
    calculate: (input: any) => ({ success: true, output: '2026-09-10T06:45:00.000Z' }),
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 2b. remind_minutes_before_event — not found
  await run('remind_minutes_before_event', { $1: '15', $2: 'nonexistent' }, {
    search_events: { success: true, output: 'no matches', data: [] },
  });

  // 2c. remind_minutes_before_event — all-day event
  await run('remind_minutes_before_event', { $1: '15', $2: 'birthday' }, {
    search_events: {
      success: true,
      output: 'id: 7, title: Birthday',
      data: [{ id: 7, title: 'Birthday', date: '2026-09-10', all_day: true }],
    },
  });

  // 3. remind_hours_before_event
  await run('remind_hours_before_event', { $1: '2', $2: 'встреча' }, {
    search_events: {
      success: true,
      output: 'found',
      data: [{ id: 11, title: 'Meeting', date: '2026-09-10', time: '14:00', all_day: false }],
    },
    calculate: () => ({ success: true, output: '2026-09-10T09:00:00.000Z' }),
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 4. remind_relative_minutes
  await run('remind_relative_minutes', { $1: '20', $2: 'позвонить маме' }, {
    calculate: () => ({ success: true, output: '2026-09-08T13:24:05.000Z' }),
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 5. remind_relative_hours — WITHOUT $1 (through "an hour")
  await run('remind_relative_hours', { $2: 'позвонить маме' }, {
    calculate: (input: any) => {
      console.log('  [calculate expr]', (input as any).expression);
      return { success: true, output: '2026-09-08T14:04:05.000Z' };
    },
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 5b. remind_relative_hours — WITH $1
  await run('remind_relative_hours', { $1: '3', $2: 'сходить в магазин' }, {
    calculate: (input: any) => {
      console.log('  [calculate expr]', (input as any).expression);
      return { success: true, output: '2026-09-08T16:04:05.000Z' };
    },
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 6. remind_at_time_today
  await run('remind_at_time_today', { $1: '9', $2: 'позвонить клиенту' }, {
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 7. remind_recurring_daily
  await run('remind_recurring_daily', { $1: '9', $2: 'пить воду' }, {
    create_event: (input: any) => ({ success: true, output: `created ${JSON.stringify(input)}` }),
  });

  // 8. cancel_reminder — found
  await run('cancel_reminder', { $1: 'стендап' }, {
    search_events: {
      success: true,
      output: 'found',
      data: [{ id: 42, title: 'Стендап', date: '2026-09-10', time: '10:00', all_day: false }],
    },
    delete_event: (input: any) => ({ success: true, output: `deleted ${JSON.stringify(input)}` }),
  });

  // 8b. cancel_reminder — not found
  await run('cancel_reminder', { $1: 'nonexistent' }, {
    search_events: { success: true, output: 'no matches', data: [] },
  });
}

await main();
