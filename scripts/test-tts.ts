#!/usr/bin/env bun
// Full TTS pipeline test: strip markdown → stress → transliterate → Silero → play
// Usage: bun scripts/test-tts.ts "На сегодня одно событие: 📅 Тест — в 15:00"
// Or pipe: echo "текст" | bun scripts/test-tts.ts

import { StressDictionary } from '../src/services/voice/stress-dictionary.ts';
import { markStress, stripMarkdown, transliterateEnglish } from '../src/services/voice/stress-marker.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dict = await StressDictionary.loadFromFile('data/dictionaries/stress-dict.json');

let text = process.argv.slice(2).join(' ');
if (!text) {
  const reader = Bun.stdin.stream().getReader();
  const { value } = await reader.read();
  text = new TextDecoder().decode(value).trim();
}

if (!text) {
  console.log('Usage: bun scripts/test-tts.ts "текст для озвучки"');
  process.exit(1);
}

console.log('Input:', text);

const plain = stripMarkdown(text);
console.log('Stripped:', plain);

const stressed = markStress(plain, dict);
console.log('Stressed:', stressed);

const final = transliterateEnglish(stressed);
console.log('Final:', final);

const outPath = join(tmpdir(), `tts-test-${Date.now()}.ogg`);
const proc = Bun.spawn(['/tmp/tts-test/bin/python3', 'scripts/silero-tts.py', final, outPath], {
  stdout: 'inherit',
  stderr: 'inherit',
});
await proc.exited;

console.log(`\nAudio: ${outPath}`);
Bun.spawn(['open', outPath]);
