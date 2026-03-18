#!/usr/bin/env bun
// Usage: bun scripts/test-kokoro.ts "Hello, your meeting is at 3pm"

import { InferenceClient } from '@huggingface/inference';

const HF_TOKEN = process.env.HF_TOKEN ?? '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';
const text = process.argv[2] ?? 'Hello! Your meeting tomorrow at 3 pm has been added to your calendar.';
const outFile = '/tmp/kokoro-test.wav';

const hf = new InferenceClient(HF_TOKEN);

console.log(`Synthesizing: "${text}"`);
const audio = await hf.textToSpeech({
  model: 'hexgrad/Kokoro-82M',
  inputs: text,
});

const buf = Buffer.from(await audio.arrayBuffer());
await Bun.write(outFile, buf);
console.log(`Saved: ${outFile} (${buf.length} bytes)`);

const proc = Bun.spawn(['afplay', outFile], { stdout: 'inherit', stderr: 'inherit' });
await proc.exited;
