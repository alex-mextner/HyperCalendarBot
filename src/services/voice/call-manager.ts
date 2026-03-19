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
  primaryTts?: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  fallbackTts: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  callLogRepo: {
    updateStatus: (id: number, status: CallStatus) => void;
    complete: (id: number, status: CallStatus, duration: number, error?: string) => void;
  };
  translateText?: (text: string, lang: string) => Promise<string>;
  sendVoiceMessage?: (userId: number, audio: Buffer) => Promise<void>;
  pyBridgePath: string;
  registerSession?: (sessionId: string, userId: number, language: string) => void;
  spawnProcess?: (cmd: string[], opts: { env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult;
}

export class CallManager {
  constructor(private deps: CallManagerDeps) {}

  async executeCall(job: CallReminderJobData): Promise<void> {
    const startTime = Date.now();

    try {
      // Step 1: Translate TTS text if translator available
      const textToSpeak = this.deps.translateText
        ? await this.deps.translateText(job.ttsText, job.language)
        : job.ttsText;

      // Step 2: Synthesize TTS audio (primary first, fallback on error)
      voiceLogger.info({ userId: job.userId, eventId: job.eventId }, 'Synthesizing TTS');
      let audioBuffer: Buffer;
      let usedFallback = false;
      if (this.deps.primaryTts) {
        try {
          audioBuffer = await this.deps.primaryTts.synthesize(textToSpeak, job.language);
        } catch (primaryErr) {
          voiceLogger.warn({ err: primaryErr }, 'Primary TTS failed, trying fallback');
          audioBuffer = await this.deps.fallbackTts.synthesize(textToSpeak, job.language);
          usedFallback = true;
        }
      } else {
        audioBuffer = await this.deps.fallbackTts.synthesize(textToSpeak, job.language);
        usedFallback = true;
      }

      // Step 3: Write audio file (primary = OGG Opus natively; fallback = MP3, needs ffmpeg)
      const oggFile = `/tmp/call-${job.callLogId}.ogg`;
      if (usedFallback) {
        // TtsService returns MP3 — convert to OGG Opus for pytgcalls
        const mp3File = `/tmp/call-${job.callLogId}-raw.mp3`;
        await Bun.write(mp3File, audioBuffer);
        const ffmpeg = Bun.spawn([
          'ffmpeg',
          '-y',
          '-i',
          mp3File,
          '-c:a',
          'libopus',
          '-ar',
          '48000',
          '-ac',
          '1',
          oggFile,
        ]);
        await ffmpeg.exited;
        try {
          await (await import('node:fs/promises')).unlink(mp3File);
        } catch {}
      } else {
        // Silero/Kokoro already output OGG Opus
        await Bun.write(oggFile, audioBuffer);
      }

      // Step 4: Register session before spawning Python bridge
      this.deps.registerSession?.(job.sessionId, job.userId, job.language);

      // Step 5: Ring + spawn Python bridge
      this.deps.callLogRepo.updateStatus(job.callLogId, 'ringing');
      voiceLogger.info({ userId: job.userId, sessionId: job.sessionId }, 'Calling via Python bridge');

      const spawn = this.deps.spawnProcess ?? Bun.spawn;
      const proc = spawn(['venv/bin/python', this.deps.pyBridgePath, String(job.userId), job.sessionId, job.language], {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const errors = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (errors) voiceLogger.warn({ stderr: errors.slice(0, 200) }, 'Bridge stderr');
      voiceLogger.info({ exitCode, userId: job.userId }, 'Bridge exited');

      // Cleanup
      try {
        await (await import('node:fs/promises')).unlink(oggFile);
      } catch {}

      const duration = Math.floor((Date.now() - startTime) / 1000);
      this.deps.callLogRepo.complete(job.callLogId, exitCode === 0 ? 'completed' : 'failed', duration);
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
      voiceLogger.error({ err: error, userId: job.userId }, 'Call failed');
      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, errorMsg);
    }
  }
}
