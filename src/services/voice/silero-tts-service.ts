// src/services/voice/silero-tts-service.ts

import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { voiceLogger } from './types';

const SCRIPT_PATH = 'scripts/silero-tts.py';

export class SileroTtsService {
  private pythonPath: string;

  constructor(pythonPath: string) {
    this.pythonPath = pythonPath;
  }

  async synthesize(stressedText: string, speaker = 'xenia'): Promise<Buffer> {
    const outPath = join(tmpdir(), `silero-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
    const startMs = Date.now();

    try {
      const proc = Bun.spawn([this.pythonPath, SCRIPT_PATH, stressedText, outPath, speaker], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        voiceLogger.error({ exitCode, stderr: stderr.slice(0, 300) }, 'Silero TTS failed');
        throw new Error(`Silero TTS failed: exit ${exitCode}`);
      }

      const file = Bun.file(outPath);
      const buffer = Buffer.from(await file.arrayBuffer());
      const elapsed = Date.now() - startMs;

      voiceLogger.info({ elapsed, audioBytes: buffer.length, speaker }, 'Silero TTS synthesized');
      return buffer;
    } finally {
      await unlink(outPath).catch(() => {});
    }
  }
}
