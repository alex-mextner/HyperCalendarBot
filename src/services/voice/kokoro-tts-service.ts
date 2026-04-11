// src/services/voice/kokoro-tts-service.ts

import { unlink } from 'node:fs/promises';
import { InferenceClient } from '@huggingface/inference';
import { voiceLogger } from './types.ts';

/** Result of a WAV→OGG conversion step (ffmpeg by default, injectable for tests) */
export interface WavToOggResult {
  ok: boolean;
  exitCode?: number;
  stderr?: string;
}

export type ConvertWavToOgg = (wavFile: string, oggFile: string) => Promise<WavToOggResult>;

async function ffmpegWavToOgg(wavFile: string, oggFile: string): Promise<WavToOggResult> {
  const proc = Bun.spawn(['ffmpeg', '-y', '-i', wavFile, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', oggFile], {
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) return { ok: true, exitCode };
  const stderr = await new Response(proc.stderr).text();
  return { ok: false, exitCode, stderr: stderr.slice(0, 200) };
}

export class KokoroTtsService {
  private client: InferenceClient;
  private convertWavToOgg: ConvertWavToOgg;

  constructor(hfToken: string, convertWavToOgg: ConvertWavToOgg = ffmpegWavToOgg) {
    this.client = new InferenceClient(hfToken);
    this.convertWavToOgg = convertWavToOgg;
  }

  async synthesize(text: string): Promise<Buffer> {
    const startMs = Date.now();
    const audio = await this.client.textToSpeech({
      model: 'hexgrad/Kokoro-82M',
      inputs: text,
    });
    const wavBuffer = Buffer.from(await audio.arrayBuffer());

    // HF API returns WAV — convert to OGG Opus for pytgcalls compatibility
    const tmpWav = `/tmp/kokoro-${Date.now()}.wav`;
    const tmpOgg = `/tmp/kokoro-${Date.now()}.ogg`;
    await Bun.write(tmpWav, wavBuffer);

    const result = await this.convertWavToOgg(tmpWav, tmpOgg);

    await unlink(tmpWav).catch(() => {});

    if (!result.ok) {
      await unlink(tmpOgg).catch(() => {});
      throw new Error(`ffmpeg WAV→OGG failed (exit ${result.exitCode ?? '?'}): ${result.stderr ?? ''}`);
    }

    const oggBuffer = Buffer.from(await Bun.file(tmpOgg).arrayBuffer());
    await unlink(tmpOgg).catch(() => {});

    voiceLogger.info({ elapsed: Date.now() - startMs, audioBytes: oggBuffer.length }, 'Kokoro TTS synthesized');
    return oggBuffer;
  }
}
