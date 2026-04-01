// src/services/voice/transcription-service.ts
import { voiceLogger } from './types';

const GROQ_WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';

export class TranscriptionService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async transcribe(audioBuffer: Buffer): Promise<string> {
    const startMs = Date.now();

    const form = new FormData();
    form.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');

    const response = await fetch(GROQ_WHISPER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      voiceLogger.error({ status: response.status, body: body.slice(0, 200) }, 'Groq Whisper API error');
      throw new Error(`Whisper transcription failed: HTTP ${response.status}`);
    }

    const result = (await response.json()) as { text?: string };
    const text = result.text?.trim() ?? '';
    const elapsed = Date.now() - startMs;

    voiceLogger.info({ elapsed, textLen: text.length }, 'Voice transcribed (Groq)');
    return text;
  }
}
