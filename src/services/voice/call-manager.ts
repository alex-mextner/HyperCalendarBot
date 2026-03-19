// src/services/voice/call-manager.ts
import type { CallStatus } from '../../database/types';
import type { CallReminderJobData } from './types';
import { voiceLogger } from './types';

type SpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export interface CallManagerDeps {
  ttsService: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  callLogRepo: {
    updateStatus: (id: number, status: CallStatus) => void;
    complete: (id: number, status: CallStatus, duration: number, error?: string) => void;
  };
  translateText?: (text: string, lang: string) => Promise<string>;
  sendVoiceMessage?: (userId: number, audio: Buffer) => Promise<void>;
  pyBridgePath: string;
  spawnProcess?: (cmd: string[], opts: { env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult;
}

export class CallManager {
  constructor(private deps: CallManagerDeps) {}

  async executeCall(job: CallReminderJobData): Promise<void> {
    const startTime = Date.now();

    try {
      // Step 1: Translate TTS text to target language if translator is available
      const textToSpeak = this.deps.translateText
        ? await this.deps.translateText(job.ttsText, job.language)
        : job.ttsText;

      // Step 2: Synthesize TTS audio to temp file
      voiceLogger.info({ userId: job.userId, eventId: job.eventId }, 'Synthesizing TTS');
      const audioBuffer = await this.deps.ttsService.synthesize(textToSpeak, job.language);
      const tmpFile = `/tmp/call-${job.callLogId}.mp3`;
      await Bun.write(tmpFile, audioBuffer);

      // Step 3: Ring + send voice message via Python bridge
      this.deps.callLogRepo.updateStatus(job.callLogId, 'ringing');
      voiceLogger.info({ userId: job.userId }, 'Calling via Python bridge');

      // Duration: estimate from audio length + buffer
      const audioDurationSec = Math.ceil(audioBuffer.length / 8000) + 5;
      const spawn = this.deps.spawnProcess ?? Bun.spawn;
      const proc = spawn(
        ['venv/bin/python', this.deps.pyBridgePath, String(job.userId), tmpFile, String(audioDurationSec)],
        { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
      );

      const output = await new Response(proc.stdout).text();
      const errors = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (errors) voiceLogger.warn({ stderr: errors.slice(0, 200) }, 'Bridge stderr');

      const lines = output.split('\n');
      const hasPlaying = lines.some((l) => l.includes('PLAYING'));
      const hasCallDone = lines.some((l) => l.includes('CALL_DONE'));

      voiceLogger.info({ exitCode, hasPlaying, hasCallDone, userId: job.userId }, 'Bridge result');

      // Cleanup
      try {
        (await Bun.file(tmpFile).exists()) && (await import('node:fs/promises')).unlink(tmpFile);
      } catch {}

      const duration = Math.floor((Date.now() - startTime) / 1000);
      this.deps.callLogRepo.complete(job.callLogId, hasPlaying ? 'completed' : 'failed', duration);
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
      voiceLogger.error(
        { error: errorMsg, stack: error instanceof Error ? error.stack : undefined, userId: job.userId },
        'Call failed',
      );

      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, errorMsg);
    }
  }
}
