#!/usr/bin/env bun
/**
 * Generates pre-recorded thinking phrase audio files for live calls.
 * Uses SileroTtsService for Russian and KokoroTtsService for English —
 * same engines as normal bot voice replies, so the voice matches.
 * Both produce OGG Opus natively; no ffmpeg needed.
 * Idempotent — skips existing files.
 *
 * Usage: bun run scripts/generate-call-phrases.ts
 * Env vars:
 *   PYTHON_PATH — path to Python binary for Silero TTS (default: venv/bin/python)
 *   HF_TOKEN    — Hugging Face token for Kokoro TTS (required for EN phrases)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { KokoroTtsService } from '../src/services/voice/kokoro-tts-service.ts';
import { SileroTtsService } from '../src/services/voice/silero-tts-service.ts';
import { StressDictionary } from '../src/services/voice/stress-dictionary.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../src/services/voice/stress-marker.ts';

const RU_PHRASES: Record<string, string> = {
  'start_hmm.ogg': 'Хмм.',
  'start_sec.ogg': 'Секундочку.',
  'start_look.ogg': 'Сейчас посмотрю.',
  'start_think.ogg': 'Дай подумаю.',
  'mid_checking.ogg': 'Проверяю.',
  'mid_moment.ogg': 'Момент.',
  'mid_almost.ogg': 'Почти готово.',
  'mid_looking.ogg': 'Смотрю в календарь.',
  'stt_error.ogg': 'Не расслышал. Попробуй ещё раз.',
};

const EN_PHRASES: Record<string, string> = {
  'start_hmm.ogg': 'Hmm.',
  'start_sec.ogg': 'One second.',
  'start_look.ogg': 'Let me check.',
  'start_think.ogg': 'Let me think.',
  'mid_checking.ogg': 'Checking.',
  'mid_moment.ogg': 'Just a moment.',
  'mid_almost.ogg': 'Almost there.',
  'mid_looking.ogg': 'Looking at your calendar.',
  'stt_error.ogg': "Sorry, I couldn't hear you. Please try again.",
};

async function generate() {
  const pythonPath = process.env.PYTHON_PATH ?? 'venv/bin/python';
  const hfToken = process.env.HF_TOKEN;

  // Russian — SileroTts
  const stressDict = await StressDictionary.loadFromFile('data/dictionaries/stress-dict.json');
  const sileroTts = new SileroTtsService(pythonPath);

  const ruDir = 'data/call-phrases/ru';
  mkdirSync(ruDir, { recursive: true });

  for (const [file, text] of Object.entries(RU_PHRASES)) {
    const path = `${ruDir}/${file}`;
    if (existsSync(path)) {
      console.log(`Skip: ${path}`);
      continue;
    }
    console.log(`RU: ${path} — "${text}"`);
    try {
      const plain = fixLineBreaks(stripMarkdown(text));
      const stressed = transliterateEnglish(markStress(numbersToWords(fixDateOrdinals(plain)), stressDict));
      const audio = await sileroTts.synthesize(stressed);
      await Bun.write(path, audio);
      console.log(`  OK (${audio.length} bytes)`);
    } catch (err) {
      console.error(`  FAIL: ${err}`);
    }
  }

  // English — KokoroTts
  if (!hfToken) {
    console.warn('HF_TOKEN not set — skipping EN phrases');
  } else {
    const kokoroTts = new KokoroTtsService(hfToken);

    const enDir = 'data/call-phrases/en';
    mkdirSync(enDir, { recursive: true });

    for (const [file, text] of Object.entries(EN_PHRASES)) {
      const path = `${enDir}/${file}`;
      if (existsSync(path)) {
        console.log(`Skip: ${path}`);
        continue;
      }
      console.log(`EN: ${path} — "${text}"`);
      try {
        const audio = await kokoroTts.synthesize(text);
        await Bun.write(path, audio);
        console.log(`  OK (${audio.length} bytes)`);
      } catch (err) {
        console.error(`  FAIL: ${err}`);
      }
    }
  }

  console.log('Done.');
}

await generate();
