// src/services/voice/kokoro-tts-service.ts

import { unlink } from 'node:fs/promises';
import { InferenceClient } from '@huggingface/inference';
import { voiceLogger } from './types.ts';

export class KokoroTtsService {
  private client: InferenceClient;

  constructor(hfToken: string) {
    this.client = new InferenceClient(hfToken);
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

    const proc = Bun.spawn(['ffmpeg', '-y', '-i', tmpWav, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', tmpOgg], {
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;

    await unlink(tmpWav).catch(() => {});

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      await unlink(tmpOgg).catch(() => {});
      throw new Error(`ffmpeg WAV→OGG failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
    }

    const oggBuffer = Buffer.from(await Bun.file(tmpOgg).arrayBuffer());
    await unlink(tmpOgg).catch(() => {});

    voiceLogger.info({ elapsed: Date.now() - startMs, audioBytes: oggBuffer.length }, 'Kokoro TTS synthesized');
    return oggBuffer;
  }
}
