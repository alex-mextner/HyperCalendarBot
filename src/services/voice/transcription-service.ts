// src/services/voice/transcription-service.ts
import { voiceLogger } from './types';

const WHISPER_MODEL = 'openai/whisper-large-v3-turbo';
const HF_INFERENCE_URL = `https://router.huggingface.co/hf-inference/models/${WHISPER_MODEL}`;

export class TranscriptionService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    const startMs = Date.now();

    const response = await fetch(HF_INFERENCE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'audio/ogg',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      voiceLogger.error({ status: response.status, body: body.slice(0, 200) }, 'Whisper API error');
      throw new Error(`Whisper transcription failed: HTTP ${response.status}`);
    }

    const result = (await response.json()) as { text?: string };
    const text = result.text?.trim() ?? '';
    const elapsed = Date.now() - startMs;

    voiceLogger.info({ elapsed, textLen: text.length }, 'Voice transcribed');
    return text;
  }
}
