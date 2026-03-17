#!/usr/bin/env bun
// Usage: bun scripts/test-stress.ts молоко встреча алексом замок календарь
// Or interactive: bun scripts/test-stress.ts

import { StressDictionary } from '../src/services/voice/stress-dictionary.ts';

const dict = await StressDictionary.loadFromFile('data/dictionaries/stress-dict.json');
console.log(`Dictionary loaded: ${dict.size} words\n`);

const args = process.argv.slice(2);

if (args.length > 0) {
  const results = dict.lookupMany(args);
  for (const [word, { stressed, similar }] of Object.entries(results)) {
    if (stressed) {
      console.log(`  ✓ ${word} → ${stressed}`);
    } else {
      console.log(`  ✗ ${word} → NOT FOUND`);
      if (similar.length > 0) {
        console.log(`    similar: ${similar.join(', ')}`);
      }
    }
  }
} else {
  console.log('Interactive mode. Type words separated by spaces. Ctrl+C to exit.\n');
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();

  process.stdout.write('> ');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const line = decoder.decode(value).trim();
    if (!line) {
      process.stdout.write('> ');
      continue;
    }
    const words = line.split(/\s+/);
    const results = dict.lookupMany(words);
    for (const [word, { stressed, similar }] of Object.entries(results)) {
      if (stressed) {
        console.log(`  ✓ ${word} → ${stressed}`);
      } else {
        console.log(`  ✗ ${word} → NOT FOUND`);
        if (similar.length > 0) {
          console.log(`    similar: ${similar.join(', ')}`);
        }
      }
    }
    process.stdout.write('> ');
  }
}
