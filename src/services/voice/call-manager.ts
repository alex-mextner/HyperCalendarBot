// src/services/voice/call-manager.ts
import type { CallReminderJobData } from './types';
import { voiceLogger } from './types';

export interface CallManagerDeps {
  ttsService: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  callSignaling: {
    initiateCall: (userId: number) => Promise<{ callId: bigint; accessHash: bigint }>;
    discardCall: (callId: bigint, accessHash: bigint) => Promise<void>;
  };
  callLogRepo: {
    updateStatus: (id: number, status: string) => void;
    complete: (id: number, status: string, duration: number, error?: string) => void;
  };
  sendPostCallButtons: (userId: number, eventId: number) => Promise<void>;
}

export class CallManager {
  constructor(private deps: CallManagerDeps) {}

  async executeCall(job: CallReminderJobData): Promise<void> {
    const startTime = Date.now();
    let callId: bigint | undefined;
    let accessHash: bigint | undefined;

    try {
      // Step 1: Synthesize TTS audio
      voiceLogger.info({ userId: job.userId, eventId: job.eventId }, 'Synthesizing TTS');
      const _audioBuffer = await this.deps.ttsService.synthesize(job.ttsText, job.language);

      // Step 2: Initiate call
      this.deps.callLogRepo.updateStatus(job.callLogId, 'ringing');
      voiceLogger.info({ userId: job.userId }, 'Initiating call');
      const callInfo = await this.deps.callSignaling.initiateCall(job.userId);
      callId = callInfo.callId;
      accessHash = callInfo.accessHash;

      // Step 3: Play audio (ntgcalls integration — placeholder for now)
      this.deps.callLogRepo.updateStatus(job.callLogId, 'connected');
      // TODO: Wire ntgcalls to play audioBuffer into the call
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Step 4: End call
      await this.deps.callSignaling.discardCall(callId, accessHash);
      const duration = Math.floor((Date.now() - startTime) / 1000);
      this.deps.callLogRepo.complete(job.callLogId, 'completed', duration);
      voiceLogger.info({ userId: job.userId, duration }, 'Call completed');

      // Step 5: Send post-call buttons in chat
      await this.deps.sendPostCallButtons(job.userId, job.eventId);
    } catch (error) {
      const duration = Math.floor((Date.now() - startTime) / 1000);
      voiceLogger.error({ error: String(error), userId: job.userId }, 'Call failed');

      if (callId && accessHash) {
        await this.deps.callSignaling.discardCall(callId, accessHash).catch(() => {});
      }

      this.deps.callLogRepo.complete(job.callLogId, 'failed', duration, String(error));

      // Still send buttons so user can snooze/cancel from chat
      await this.deps.sendPostCallButtons(job.userId, job.eventId).catch(() => {});
    }
  }
}
