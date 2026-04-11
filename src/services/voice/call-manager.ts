// src/services/voice/call-manager.ts

import { unlink } from 'node:fs/promises';
import { t } from '../../config/constants.ts';
import type { CallStatus } from '../../database/types';
import type { CallReminderJobData } from './types';
import { voiceLogger } from './types';

type SpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export interface Mp3ToOggResult {
  ok: boolean;
  stderr?: string;
}

export interface CallManagerDeps {
  primaryTts?: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  fallbackTts: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  callLogRepo: {
    updateStatus: (id: number, status: CallStatus) => void;
    complete: (id: number, status: CallStatus, duration: number, error?: string) => void;
  };
  translateText?: (text: string, lang: string) => Promise<string>;
  pyBridgePath: string;
  registerSession?: (sessionId: string, userId: number, language: string) => void;
  spawnProcess?: (cmd: string[], opts: { env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult;
  /** Convert MP3 → OGG Opus (fallback TTS returns MP3, pytgcalls needs OGG).
   *  Default impl spawns ffmpeg; tests inject a stub so they don't need ffmpeg on PATH. */
  convertMp3ToOgg?: (mp3File: string, oggFile: string) => Promise<Mp3ToOggResult>;
  notifyUser?: (userId: number, msg: string) => void;
}

async function ffmpegMp3ToOgg(mp3File: string, oggFile: string): Promise<Mp3ToOggResult> {
  const proc = Bun.spawn(['ffmpeg', '-y', '-i', mp3File, '-c:a', 'libopus', '-ar', '48000', '-ac', '1', oggFile], {
    stderr: 'pipe',
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) return { ok: true };
  const stderr = await new Response(proc.stderr).text();
  return { ok: false, stderr: stderr.slice(0, 200) };
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
        const convert = this.deps.convertMp3ToOgg ?? ffmpegMp3ToOgg;
        const result = await convert(mp3File, oggFile);
        if (!result.ok) {
          voiceLogger.warn({ stderr: result.stderr }, 'ffmpeg conversion failed');
        }
        try {
          await unlink(mp3File);
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

      // Stream stderr line-by-line in real-time so debug logs appear during the call
      const stderrTask = (async () => {
        if (!proc.stderr) return;
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim()) voiceLogger.debug({ line }, 'Bridge stderr');
          }
        }
        if (buf.trim()) voiceLogger.debug({ line: buf }, 'Bridge stderr');
      })();

      const exitCode = await proc.exited;
      await stderrTask;
      voiceLogger.info({ exitCode, userId: job.userId }, 'Bridge exited');

      // Cleanup
      try {
        await unlink(oggFile);
      } catch {}

      const duration = Math.floor((Date.now() - startTime) / 1000);
      const callStatus = exitCode === 0 ? 'completed' : 'failed';
      this.deps.callLogRepo.complete(job.callLogId, callStatus, duration);
      if (callStatus === 'failed') {
        this.deps.notifyUser?.(job.userId, t(job.language as 'en' | 'ru').aiTools.meta.callFailed(job.ttsText));
      }
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
      voiceLogger.error({ err: error, userId: job.userId }, 'Call failed');
      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, errorMsg);
      this.deps.notifyUser?.(job.userId, t(job.language as 'en' | 'ru').aiTools.meta.callFailed(job.ttsText));
    }
  }
}
