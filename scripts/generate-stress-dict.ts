/**
 * Generate stress-dict.json from OpenRussian dictionary TSV files.
 *
 * Prerequisites:
 *   git clone https://github.com/Badestrand/russian-dictionary /tmp/russian-dictionary
 *
 * Usage:
 *   bun scripts/generate-stress-dict.ts
 *
 * Output:
 *   data/dictionaries/stress-dict.json (~26 MB, ~555K entries)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const REPO_PATH = '/tmp/russian-dictionary';
const OUTPUT_PATH = 'data/dictionaries/stress-dict.json';
const FILES = ['nouns', 'verbs', 'adjectives', 'others'];

if (!existsSync(`${REPO_PATH}/nouns.csv`)) {
  console.error(`Error: ${REPO_PATH}/nouns.csv not found.`);
  console.error('Run: git clone https://github.com/Badestrand/russian-dictionary /tmp/russian-dictionary');
  process.exit(1);
}

/** OpenRussian uses apostrophe AFTER the stressed vowel: челове'к → convert to + BEFORE: челов+ек */
function accentToPlus(word: string): string {
  return word.replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])'/g, '+$1');
}

const dict = new Map<string, string>();

for (const f of FILES) {
  const path = `${REPO_PATH}/${f}.csv`;
  if (!existsSync(path)) {
    console.warn(`Skipping ${path} (not found)`);
    continue;
  }
  const lines = readFileSync(path, 'utf-8').split('\n');

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split('\t');
    for (const col of cols) {
      const val = col?.trim();
      if (!val?.includes("'")) continue;
      for (const form of val.split('/')) {
        const trimmed = form.trim();
        if (!trimmed.includes("'")) continue;
        const bare = trimmed.replace(/'/g, '').toLowerCase();
        const stressed = accentToPlus(trimmed).toLowerCase();
        if (bare !== stressed && !dict.has(bare)) {
          dict.set(bare, stressed);
        }
      }
    }
  }
}

const outDir = OUTPUT_PATH.substring(0, OUTPUT_PATH.lastIndexOf('/'));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const obj = Object.fromEntries(dict);
const json = JSON.stringify(obj);
writeFileSync(OUTPUT_PATH, json);

console.log(`Unique stressed forms: ${dict.size}`);
console.log(`Saved: ${(json.length / 1024 / 1024).toFixed(1)} MB → ${OUTPUT_PATH}`);

// Spot check
for (const w of ['человек', 'встреча', 'молоко', 'сегодня', 'календарь', 'привет']) {
  console.log(`  ${w} → ${dict.get(w) ?? 'NOT FOUND'}`);
}
