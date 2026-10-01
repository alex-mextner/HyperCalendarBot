// src/services/voice/call-manager.ts

import { t } from '../../config/constants.ts';
import type { CallStatus } from '../../database/types';
import { SERVICE_PYTHON } from '../telegram-session/service-tier.ts';
import type { CallLanguage, CallReminderJobData } from './types';
import { toCallLanguage, voiceLogger } from './types';

type SpawnResult = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

export interface CallManagerDeps {
  callLogRepo: {
    updateStatus: (id: number, status: CallStatus) => void;
    complete: (id: number, status: CallStatus, duration: number, error?: string) => void;
  };
  translateText?: (text: string, lang: string) => Promise<string>;
  pyBridgePath: string;
  /** Prepares the live session the bridge connects to; `openerText` is the first thing it speaks. */
  registerSession: (sessionId: string, userId: number, language: CallLanguage, openerText: string) => void;
  /** Drops a registered session the bridge never connected to; a no-op once it has connected. */
  unregisterSession: (sessionId: string) => void;
  spawnProcess?: (cmd: string[], opts: { env: NodeJS.ProcessEnv; stdout: 'pipe'; stderr: 'pipe' }) => SpawnResult;
  notifyUser?: (userId: number, msg: string) => void;
}

export class CallManager {
  constructor(private deps: CallManagerDeps) {}

  async executeCall(job: CallReminderJobData): Promise<void> {
    const startTime = Date.now();
    const language = toCallLanguage(job.language);

    try {
      // Step 1: Translate the reminder into the call language if a translator is available
      const textToSpeak = this.deps.translateText ? await this.deps.translateText(job.ttsText, language) : job.ttsText;

      // Step 2: Register the session before spawning the bridge; the session speaks the reminder
      // as soon as the user answers.
      this.deps.registerSession(job.sessionId, job.userId, language, textToSpeak);

      // Step 3: Ring + spawn Python bridge
      this.deps.callLogRepo.updateStatus(job.callLogId, 'ringing');
      voiceLogger.info({ userId: job.userId, sessionId: job.sessionId }, 'Calling via Python bridge');

      const spawn = this.deps.spawnProcess ?? Bun.spawn;
      const proc = spawn([SERVICE_PYTHON, this.deps.pyBridgePath, String(job.userId), job.sessionId, language], {
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

      const duration = Math.floor((Date.now() - startTime) / 1000);
      const callStatus = exitCode === 0 ? 'completed' : 'failed';
      this.deps.callLogRepo.complete(job.callLogId, callStatus, duration);
      if (callStatus === 'failed') {
        this.deps.notifyUser?.(job.userId, t(language).aiTools.meta.callFailed(job.ttsText));
      }
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
      voiceLogger.error({ err: error, userId: job.userId }, 'Call failed');
      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, errorMsg);
      this.deps.notifyUser?.(job.userId, t(language).aiTools.meta.callFailed(job.ttsText));
    } finally {
      // A bridge that failed to start or exited before connecting leaves its session pending forever.
      this.deps.unregisterSession(job.sessionId);
    }
  }
}
