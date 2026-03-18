// src/services/voice/kokoro-tts-service.ts

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
    const buffer = Buffer.from(await audio.arrayBuffer());
    voiceLogger.info({ elapsed: Date.now() - startMs, audioBytes: buffer.length }, 'Kokoro TTS synthesized');
    return buffer;
  }
}
