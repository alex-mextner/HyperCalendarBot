// Merges the authored source files into the two split files and the manifest. Deterministic: the same sources give
// byte-identical outputs. Usage: bun --no-env-file scripts/intent-benchmark/build-history.ts [--check]
// --check exits 1 when the committed outputs differ from what the sources would produce.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConversationSchema } from './history.ts';
import { problemsOf } from './validate-history.ts';

const ROOT = new URL('../../docs/intents/model-history/', import.meta.url);
const SOURCES = new URL('sources/', ROOT);
export const MODEL_HISTORY_VERSION = 1;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Built {
  files: { [name: string]: string };
}

export function build(): Built {
  const sourceNames = readdirSync(fileURLToPath(SOURCES))
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const splits: { dev: string[]; heldout: string[] } = { dev: [], heldout: [] };
  const sources: { [name: string]: { sha256: string; conversations: number } } = {};
  for (const name of sourceNames) {
    const text = readFileSync(new URL(name, SOURCES), 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    sources[name] = { sha256: sha256(text), conversations: lines.length };
    const split = name.startsWith('heldout-') ? 'heldout' : name.startsWith('dev-') ? 'dev' : null;
    if (!split) throw new Error(`source ${name} must start with dev- or heldout-`);
    splits[split].push(...lines);
  }
  const files: Built['files'] = {};
  const checksums: { [split: string]: { sha256: string; conversations: number } } = {};
  const seen = new Set<string>();
  const dropped = { dev: 0, heldout: 0 };
  for (const split of ['dev', 'heldout'] as const) {
    const prefix = split === 'dev' ? 'dev' : 'ho';
    // A stable pseudo-shuffle keeps the families of one author from clustering in the file.
    const ordered = [...splits[split]].sort((a, b) => sha256(a).localeCompare(sha256(b)));
    const out: string[] = [];
    for (const line of ordered) {
      const parsed = ConversationSchema.parse(JSON.parse(line));
      const key = `${parsed.lang}|${parsed.say.toLowerCase()}`;
      // dev is built first, so a message both splits contain stays in dev and the held-out copy is dropped.
      if (seen.has(key)) {
        dropped[split]++;
        continue;
      }
      seen.add(key);
      const conversation = { ...parsed, id: `${prefix}-${String(out.length + 1).padStart(4, '0')}` };
      const problems = problemsOf(conversation as Parameters<typeof problemsOf>[0]);
      if (problems.length > 0) throw new Error(`${conversation.id}: ${problems.join('; ')}`);
      out.push(JSON.stringify(conversation));
    }
    const body = `${out.join('\n')}\n`;
    files[`conversations.${split}.jsonl`] = body;
    checksums[split] = { sha256: sha256(body), conversations: out.length };
  }
  const manifest = {
    schemaVersion: 1,
    version: MODEL_HISTORY_VERSION,
    generator: 'scripts/intent-benchmark/build-history.ts',
    note: 'Synthetic, anonymised conversations authored independently of the rule seed (see README.md). dev is for developing rules; heldout is never used to write a rule and is measured at checkpoints.',
    files: checksums,
    sources,
    droppedDuplicates: dropped,
    total: checksums.dev!.conversations + checksums.heldout!.conversations,
    heldoutShare: checksums.heldout!.conversations / (checksums.dev!.conversations + checksums.heldout!.conversations),
    checksum: sha256(`${checksums.dev!.sha256}${checksums.heldout!.sha256}`),
  };
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  return { files };
}

if (import.meta.main) {
  const { files } = build();
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [name, body] of Object.entries(files)) {
    const target = new URL(name, ROOT);
    if (check) {
      if (!existsSync(target) || readFileSync(target, 'utf8') !== body) {
        console.error(`${name} is stale`);
        stale = true;
      }
    } else writeFileSync(target, body);
  }
  process.exit(stale ? 1 : 0);
}
