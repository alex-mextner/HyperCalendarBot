#!/usr/bin/env bun
/**
 * Demo: Russian STT via Deepgram Nova-3
 * Usage: DEEPGRAM_API_KEY=xxx bun scripts/demo-nova3.ts
 *
 * Generates Russian speech via Edge TTS, transcribes via Nova-3.
 */
import { TtsService } from '../src/services/voice/tts-service';

const API_KEY = process.env.DEEPGRAM_API_KEY;
if (!API_KEY) {
  console.error('Set DEEPGRAM_API_KEY=xxx before running');
  process.exit(1);
}

const SAMPLES = [
  'Привет! Через пятнадцать минут у тебя встреча с командой по продукту.',
  'Напоминаю, сегодня в три часа дня созвон с дизайнерами. Хочешь перенести?',
  'Завтра в девять утра у тебя важная встреча. Всё ещё актуально?',
  'Отложить на десять минут, или всё-таки отменить?',
];

const ttsService = new TtsService();

async function synthesize(text: string): Promise<Buffer> {
  return ttsService.synthesize(text, 'ru');
}

async function transcribeNova3(audio: Buffer): Promise<{ transcript: string; confidence: number; elapsed: number }> {
  const t0 = Date.now();

  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&language=ru&punctuate=true&smart_format=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Token ${API_KEY}`,
        'Content-Type': 'audio/mp3',
      },
      body: audio,
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deepgram error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    results: { channels: [{ alternatives: [{ transcript: string; confidence: number }] }] };
  };

  const alt = json.results.channels[0].alternatives[0];
  return { transcript: alt.transcript, confidence: alt.confidence, elapsed: Date.now() - t0 };
}

console.log('=== Deepgram Nova-3 Russian STT Demo ===\n');

for (const [i, text] of SAMPLES.entries()) {
  console.log(`[${i + 1}] Original:   "${text}"`);

  process.stdout.write('     Synthesizing TTS... ');
  const t0 = Date.now();
  const audio = await synthesize(text);
  console.log(`${Date.now() - t0}ms`);

  process.stdout.write('     Transcribing...     ');
  const { transcript, confidence, elapsed } = await transcribeNova3(audio);
  console.log(`${elapsed}ms`);

  console.log(`     Nova-3 result: "${transcript}"`);
  console.log(`     Confidence:    ${(confidence * 100).toFixed(1)}%`);

  const origWords = text
    .toLowerCase()
    .replace(/[,.!?-]/g, '')
    .split(' ');
  const resWords = transcript
    .toLowerCase()
    .replace(/[,.!?-]/g, '')
    .split(' ');
  const errors = origWords.filter((w, idx) => w !== resWords[idx]).length;
  const wer = ((errors / origWords.length) * 100).toFixed(1);
  console.log(`     WER (approx): ${wer}%`);
  console.log();
}

console.log('Done.');
