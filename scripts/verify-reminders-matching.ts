
import { IntentMatcher } from '../src/services/intent/intent-matcher.ts';
import { IntentExecutor } from '../src/services/intent/intent-executor.ts';
import { remindersIntents } from './seed-intents-reminders.ts';
import type { Intent } from '../src/database/types.ts';

// Build fake DB rows (id assigned sequentially) matching Intent shape closely enough for the matcher.
const fakeIntents: Intent[] = remindersIntents.map((it, i) => ({
  id: i + 1,
  canonical_name: it.canonical_name,
  phrases: JSON.stringify(it.phrases),
  trigger_words: JSON.stringify(it.trigger_words),
  pattern: it.pattern,
  workflow: JSON.stringify(it.workflow),
  format: 'text',
  status: 'approved',
  source_message: it.source_message,
  created_at: new Date().toISOString(),
})) as unknown as Intent[];

const matcher = new IntentMatcher();
matcher.load(fakeIntents);

const testMessages: Array<{ msg: string; expectIntent: string | null }> = [
  { msg: 'какие у меня напоминания про стендап', expectIntent: 'reminders_for_event' },
  { msg: 'напоминания про стендап', expectIntent: 'reminders_for_event' },
  { msg: 'show reminders for standup', expectIntent: 'reminders_for_event' },
  { msg: 'напомни за 15 минут до стендапа', expectIntent: 'remind_minutes_before_event' },
  { msg: 'remind me 10 minutes before the meeting', expectIntent: 'remind_minutes_before_event' },
  { msg: 'напомни за 2 часа до встречи', expectIntent: 'remind_hours_before_event' },
  { msg: 'remind me 1 hour before the meeting', expectIntent: 'remind_hours_before_event' },
  { msg: 'напомни через 15 минут позвонить маме', expectIntent: 'remind_relative_minutes' },
  { msg: 'remind me in 20 minutes to call mom', expectIntent: 'remind_relative_minutes' },
  { msg: 'напомни через час позвонить маме', expectIntent: 'remind_relative_hours' },
  { msg: 'remind me in an hour to call mom', expectIntent: 'remind_relative_hours' },
  { msg: 'напомни через 3 часа сходить в магазин', expectIntent: 'remind_relative_hours' },
  { msg: 'remind me in 3 hours to go shopping', expectIntent: 'remind_relative_hours' },
  { msg: 'напомни в 9 позвонить клиенту', expectIntent: 'remind_at_time_today' },
  { msg: 'remind me at 15 to call the client', expectIntent: 'remind_at_time_today' },
  { msg: 'напоминай мне каждый день в 9 пить воду', expectIntent: 'remind_recurring_daily' },
  { msg: 'remind me every day at 8 to take vitamins', expectIntent: 'remind_recurring_daily' },
  { msg: 'отмени напоминание про стендап', expectIntent: 'cancel_reminder' },
  { msg: 'убери напоминание позвонить маме', expectIntent: 'cancel_reminder' },
  { msg: 'cancel reminder to call mom', expectIntent: 'cancel_reminder' },
  { msg: 'cancel the reminder for standup', expectIntent: 'cancel_reminder' },
  // Should NOT match anything reminder-related (sanity: unrelated message)
  { msg: 'что у меня сегодня', expectIntent: null },
];

let allMatchOk = true;
for (const { msg, expectIntent } of testMessages) {
  const result = matcher.match(msg);
  const gotName = result ? fakeIntents.find((i) => i.id === result.intentId)?.canonical_name : null;
  const ok = gotName === expectIntent;
  if (!ok) allMatchOk = false;
  console.log(`${ok ? 'OK' : 'FAIL'} "${msg}" → ${gotName} (expected ${expectIntent})`, result?.captures ?? '');
}
console.log(allMatchOk ? '\nALL MATCH TESTS PASS' : '\nMATCH FAILURES PRESENT');
