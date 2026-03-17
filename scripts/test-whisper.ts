#!/usr/bin/env bun
// Test Whisper transcription on a local audio file
// Usage: bun scripts/test-whisper.ts <audio_file.ogg>

import { TranscriptionService } from '../src/services/voice/transcription-service.ts';

const filePath = process.argv[2];
if (!filePath) {
  console.log('Usage: bun scripts/test-whisper.ts <audio_file.ogg|mp3|wav>');
  process.exit(1);
}

const token = process.env.HF_TOKEN;
if (!token) {
  console.log('HF_TOKEN not set in environment');
  process.exit(1);
}

const service = new TranscriptionService(token);
const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());

console.log(`Transcribing: ${filePath} (${buffer.length} bytes)`);
const start = Date.now();
const text = await service.transcribe(buffer);
console.log(`Result (${Date.now() - start}ms): ${text}`);
