// Shows how the current rule set treats a few typed messages, for rule development (reads no corpus).
//   bun --no-env-file scripts/intent-benchmark/probe.ts [--date 2026-03-17] [--clock "tue 11:16"] [--tz Europe/Belgrade] "text" ...
import './quiet.ts';
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { intentRows } from '../../src/services/intent/seed-replacement.ts';
import { defaultAnchor } from './anchor.ts';
import { parseConversationLine } from './history.ts';
import { runConversation } from './run.ts';
import { buildTemplate } from './world.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    date: { type: 'string', default: '2026-03-17' },
    clock: { type: 'string', default: 'tue 11:16' },
    tz: { type: 'string', default: 'Europe/Belgrade' },
    lang: { type: 'string', default: 'ru' },
    world: { type: 'string', default: 'rich' },
    // An event the calendar holds: "Title" or "123=Title" (number=title); tomorrow at 12:00.
    seed: { type: 'string', multiple: true },
  },
  strict: true,
});
const [day, at] = (values.clock ?? 'tue 11:16').split(' ');
const template = buildTemplate(seedIntents);
const db = Database.deserialize(template.image);
const matcher = new IntentMatcher();
matcher.load(intentRows(db));
db.close();
for (const [index, say] of positionals.entries()) {
  const conversation = parseConversationLine(
    JSON.stringify({
      id: `probe-${index}`,
      lang: values.lang,
      chat: 'private',
      tz: values.tz,
      clock: { day, at },
      date: values.date,
      world: values.world,
      ...(values.seed
        ? {
            seedEvents: values.seed.map((item) => {
              const [id, title] = item.includes('=') ? item.split('=') : [undefined, item];
              return { ...(id ? { id: Number(id) } : {}), title, dayOffset: 1, at: '12:00', durationMin: 60 };
            }),
          }
        : {}),
      say,
      expect: { route: 'ai', why: 'unsupported', intentLike: true },
    }),
  );
  const result = await runConversation(
    { template, matcher },
    conversation,
    defaultAnchor(conversation),
    `probe-${index}`,
  );
  const first = result.turns[0];
  console.log(
    `${JSON.stringify(say)} -> ${first?.handled ? `RULE ${result.ruleName}` : 'AI'}${first?.messages.at(-1)?.text ? ` | ${first.messages.at(-1)?.text.replace(/\n/g, ' / ').slice(0, 200)}` : ''}`,
  );
}
