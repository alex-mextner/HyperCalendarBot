// Structural and semantic checks for authored model-history files. Usage:
//   bun --no-env-file scripts/intent-benchmark/validate-history.ts <file.jsonl>...
// Exit 0 when every line is valid; every problem is printed with its line number.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  type Conversation,
  ConversationSchema,
  expandPlaceholders,
  FAMILY_IDS,
  type FamilyId,
  hasUnexpandedPlaceholder,
} from './history.ts';

const FamiliesFile = z.object({
  families: z.record(z.string(), z.object({ kind: z.string(), scope: z.enum(['any', 'private']) })),
});
const WorldFile = z.object({
  events: z.array(z.object({ id: z.number(), title: z.object({ ru: z.string(), en: z.string() }) })),
});

const root = new URL('../../docs/intents/model-history/', import.meta.url);
const families = FamiliesFile.parse(JSON.parse(readFileSync(new URL('families.json', root), 'utf8'))).families;
const world = WorldFile.parse(JSON.parse(readFileSync(new URL('world.json', root), 'utf8')));

type RuleExpectation = Extract<Conversation['expect'], { route: 'rule' }>;

function ruleProblems(conversation: Conversation, expect: RuleExpectation): string[] {
  const problems: string[] = [];
  const spec = families[expect.family];
  if (!spec) problems.push(`unknown family ${expect.family}`);
  else if (spec.scope === 'private' && conversation.chat === 'group')
    problems.push(`family ${expect.family} is private-only but the chat is a group`);
  const slots = expect.slots as { ref?: { title?: string } };
  const wanted = slots.ref?.title;
  if (wanted) {
    const hits = world.events.filter((event) =>
      event.title[conversation.lang].toLowerCase().includes(wanted.toLowerCase()),
    );
    if (hits.length !== 1)
      problems.push(
        `ref title "${wanted}" matches ${hits.length} world events in ${conversation.lang}, need exactly 1`,
      );
  }
  const isWrite = spec?.kind === 'write';
  if (!isWrite && conversation.then?.length) problems.push('follow-up messages on a read family');
  if (!isWrite && expect.confirm) problems.push('confirm on a read family');
  return problems;
}

/** Collects every problem of one conversation; the order of messages never matters. */
export function problemsOf(conversation: Conversation): string[] {
  const problems: string[] = [];
  const today = { y: 2026, m: 10, d: 5 };
  for (const text of [conversation.say, ...(conversation.then ?? [])]) {
    if (hasUnexpandedPlaceholder(expandPlaceholders(text, today))) problems.push(`bad placeholder in "${text}"`);
    if (text !== text.trim()) problems.push(`message has leading/trailing spaces: "${text}"`);
  }
  if (conversation.expect.route === 'rule') problems.push(...ruleProblems(conversation, conversation.expect));
  return problems;
}

/** Reports every problem of one non-blank line and returns how many there were. */
function checkLine(where: string, line: string, seen: Set<string>, perFamily: Map<string, number>): number {
  const parsed = ConversationSchema.safeParse(JSON.parse(line));
  if (!parsed.success) {
    console.error(`${where}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return 1;
  }
  let bad = 0;
  const conversation = parsed.data as Conversation;
  const key = `${conversation.lang}|${conversation.say.toLowerCase()}`;
  if (seen.has(key)) {
    bad++;
    console.error(`${where}: duplicate message "${conversation.say}"`);
  }
  seen.add(key);
  for (const problem of problemsOf(conversation)) {
    bad++;
    console.error(`${where}: ${problem}`);
  }
  const label = conversation.expect.route === 'rule' ? conversation.expect.family : `ai:${conversation.expect.why}`;
  perFamily.set(label, (perFamily.get(label) ?? 0) + 1);
  return bad;
}

function main(files: string[]): number {
  let bad = 0;
  const seen = new Set<string>();
  const perFamily = new Map<string, number>();
  let total = 0;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      total++;
      bad += checkLine(`${file}:${index + 1}`, line, seen, perFamily);
    }
  }
  const known = new Set<string>(FAMILY_IDS);
  for (const id of Object.keys(families))
    if (!known.has(id as FamilyId)) console.error(`families.json lists ${id} unknown to history.ts`);
  console.log(`${total} conversations, ${bad} problems`);
  for (const [label, count] of [...perFamily].sort()) console.log(`  ${label}: ${count}`);
  return bad === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
