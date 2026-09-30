// src/services/voice/call-session.ts
import { unlink as fsUnlink } from 'node:fs/promises';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import type { AgentContext } from '../ai/types.ts';
import type { FluxStreamingSTT } from './flux-streaming-stt.ts';
import { classifyInterrupt } from './interruption-classifier.ts';
import type { NovaStreamingSTT } from './nova-streaming-stt.ts';
import { fixLineBreaks, stripMarkdown } from './stress-marker.ts';
import type { ThinkingPhrasePlayer } from './thinking-phrase-player.ts';
import { voiceLogger } from './types.ts';

type NovaStt = Pick<NovaStreamingSTT, 'connect' | 'sendAudio' | 'close'>;
type FluxStt = Pick<FluxStreamingSTT, 'connect' | 'sendAudio' | 'close'>;
type ThinkingPlayer = Pick<ThinkingPhrasePlayer, 'start' | 'cancel'>;

/** What the caller said in one turn. */
export interface CallTurn {
  userId: number;
  transcript: string;
}

/** The agent's reply to one call turn; `endCall` hangs up after the reply finishes playing. */
export interface CallAgentReply {
  responseText?: string;
  endCall?: boolean;
}

/** The session's view of the agent: one caller turn in, one spoken reply out. */
export interface CallAgent {
  run: (turn: CallTurn) => Promise<CallAgentReply>;
}

/** Everything an agent turn needs besides the caller and the transcript, which each turn supplies. */
export type CallAgentContextBase = Omit<AgentContext, 'user' | 'chatId' | 'messageText' | 'inputMode' | 'isGroup'>;

/** Adapts the full agent to call turns: the caller becomes the private-chat user of a live-call turn. */
export function createCallAgent(
  agent: { run: (ctx: AgentContext) => Promise<CallAgentReply> },
  base: CallAgentContextBase,
): CallAgent {
  return {
    run: async ({ userId, transcript }) => {
      const user = base.userRepo.findByTelegramId(userId);
      // The agent needs the caller's stored profile (timezone, calendar); without it there is no reply.
      if (!user) {
        voiceLogger.warn({ userId }, 'Call agent turn skipped: caller has no user record');
        return {};
      }
      return agent.run({
        ...base,
        user,
        chatId: userId,
        messageText: transcript,
        inputMode: 'live_call',
        isGroup: false,
      });
    },
  };
}

export interface CallSessionConfig {
  sessionId: string;
  userId: number;
  language: 'ru' | 'en';
  ws: { send: (data: string | Buffer) => void; close: () => void };
  createNovaStt: () => NovaStt;
  createFluxStt: () => FluxStt;
  createThinkingPlayer: () => ThinkingPlayer;
  agent: CallAgent;
  tts: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  openerText: string;
  unlink?: (path: string) => Promise<void>;
  sttErrorTimeoutMs?: number;
}

export class CallSession {
  private ended = false;
  private speaking = false;
  private agentRunning = false;
  private novaStt: NovaStt | null = null;
  private fluxStt: FluxStt | null = null;
  private thinking: ThinkingPlayer | null = null;
  private fileSeq = 0;
  lastPlayFile: string | null = null;
  private tmpFiles = new Set<string>();
  private rollingTranscript = '';
  private pendingErrorPhrase: string | null = null;
  private endCallAfterCurrentPlay = false;
  private sttErrorTimeout: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly INACTIVITY_MS = 4 * 60 * 1000; // 4 minutes

  private constructor(private readonly cfg: CallSessionConfig) {}

  static create(cfg: CallSessionConfig): CallSession {
    return new CallSession(cfg);
  }

  async handleMessage(data: string): Promise<void> {
    if (this.ended) return;
    const result = jsonCodec(z.object({ type: z.string() })).safeParse(data);
    if (!result.success) return;
    const msg = result.data;

    switch (msg.type) {
      case 'CALL_CONNECTED':
        await this.onCallConnected();
        break;
      case 'VAD_START':
        this.onVadStart();
        break;
      case 'VAD_END':
        this.onVadEnd();
        break;
      case 'PLAY_DONE':
        await this.onPlayDone();
        break;
      case 'CALL_ENDED':
        this.onCallEnded();
        break;
    }
  }

  handleBinaryMessage(data: Buffer): void {
    // Both RU and EN paths: bridge prepends a 2-byte big-endian seq_num header — strip it.
    const pcm = data.subarray(2);
    if (this.cfg.language === 'ru') {
      if (!this.speaking) return;
      this.novaStt?.sendAudio(pcm);
    } else {
      // EN: bridge streams audio continuously (no Python VAD); Flux handles turn detection.
      this.fluxStt?.sendAudio(pcm);
    }
  }

  isEnded(): boolean {
    return this.ended;
  }

  forceEnd(): void {
    this.onCallEnded();
  }

  private async onCallConnected(): Promise<void> {
    voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Call connected');
    if (this.cfg.language === 'en') {
      this.fluxStt = this.cfg.createFluxStt();
      this.fluxStt.connect({
        onStartOfTurn: () => {
          this.resetInactivityTimer();
          this.send(JSON.stringify({ type: 'PAUSE' }));
        },
        onEndOfTurn: (confidence: number, finalTranscript: string) => {
          if (finalTranscript) this.rollingTranscript = finalTranscript;
          voiceLogger.info(
            { sessionId: this.cfg.sessionId, transcript: this.rollingTranscript, confidence },
            'Flux EndOfTurn',
          );
          this.onEnoughToRespond();
        },
        onInterim: (t: string) => {
          voiceLogger.debug({ sessionId: this.cfg.sessionId, transcript: t }, 'Flux interim');
          this.rollingTranscript = t;
        },
        onError: (err: Error) => {
          voiceLogger.warn({ err, sessionId: this.cfg.sessionId }, 'Flux STT error');
          this.playErrorPhrase();
        },
      });
    }
    await this.playOpener();
  }

  private async playOpener(): Promise<void> {
    try {
      const audio = await this.cfg.tts.synthesize(this.cfg.openerText, this.cfg.language);
      const file = this.tempFile();
      await Bun.write(file, audio);
      this.sendPlay(file);
    } catch (err) {
      voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Failed to synthesize opener');
    }
  }

  private onVadStart(): void {
    this.resetInactivityTimer(); // user started speaking — reset idle timer
    this.speaking = true;
    this.rollingTranscript = '';
    this.send(JSON.stringify({ type: 'PAUSE' }));

    if (this.cfg.language === 'ru') {
      this.novaStt = this.cfg.createNovaStt();
      this.novaStt.connect({
        onInterim: (t: string) => this.onNovaInterim(t),
        onFinal: (t: string) => {
          this.rollingTranscript = t;
        },
        onError: (err: Error) => {
          voiceLogger.warn({ err, sessionId: this.cfg.sessionId }, 'Nova-3 STT error');
          this.playErrorPhrase();
        },
      });
    }
  }

  private onNovaInterim(transcript: string): void {
    this.rollingTranscript = transcript;
    const decision = classifyInterrupt(transcript);
    if (decision === 'respond') {
      this.onEnoughToRespond();
    } else if (decision === 'noise' || decision === 'resume') {
      this.send(JSON.stringify({ type: 'RESUME' }));
      this.closeSttEpisode();
    }
  }

  private onVadEnd(): void {
    if (!this.speaking) return;
    this.speaking = false;
    if (this.cfg.language === 'ru') {
      this.novaStt?.close();
      this.novaStt = null;
    }
    this.onEnoughToRespond();
  }

  private onEnoughToRespond(): void {
    if (this.agentRunning) return;
    if (!this.rollingTranscript.trim()) return;
    this.agentRunning = true;

    this.speaking = false;
    this.novaStt?.close();
    this.novaStt = null;

    this.thinking = this.cfg.createThinkingPlayer();
    this.thinking.start((cmd) => this.send(JSON.stringify(cmd)));

    const transcript = this.rollingTranscript;
    this.rollingTranscript = '';
    voiceLogger.info({ sessionId: this.cfg.sessionId, transcript }, 'Running agent');

    // TODO(#755): spec requires a 10s fail-open timer — if agent takes longer, resume listening
    this.runAgent(transcript).catch((err) => {
      voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
    });
  }

  private async runAgent(transcript: string): Promise<void> {
    try {
      let responseText: string | undefined;
      let endCall = false;
      try {
        const result = await this.cfg.agent.run({ userId: this.cfg.userId, transcript });
        responseText = result.responseText;
        endCall = result.endCall === true;
      } catch (err) {
        voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
        return;
      } finally {
        this.thinking?.cancel();
        this.thinking = null;
      }

      if (endCall) {
        this.endCallAfterCurrentPlay = true;
      }

      if (!responseText) return;

      const spokenText = fixLineBreaks(stripMarkdown(responseText));

      voiceLogger.info({ sessionId: this.cfg.sessionId, responseText: spokenText }, 'TTS response');

      try {
        const audio = await this.cfg.tts.synthesize(spokenText, this.cfg.language);
        const file = this.tempFile();
        await Bun.write(file, audio);
        this.sendPlay(file);
      } catch (err) {
        voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'TTS synthesis failed during call');
      }
    } finally {
      this.agentRunning = false;
    }
  }

  private async onPlayDone(): Promise<void> {
    const shouldEndCall = this.endCallAfterCurrentPlay;
    this.endCallAfterCurrentPlay = false;

    if (this.lastPlayFile) {
      const del = this.cfg.unlink ?? fsUnlink;
      await del(this.lastPlayFile).catch(() => {});
      this.tmpFiles.delete(this.lastPlayFile);
      this.lastPlayFile = null;
    }

    if (this.pendingErrorPhrase) {
      const file = this.pendingErrorPhrase;
      this.pendingErrorPhrase = null;
      this.endCallAfterCurrentPlay = true;
      this.send(JSON.stringify({ type: 'STOP' }));
      this.send(JSON.stringify({ type: 'PLAY', file }));
      return;
    }

    if (shouldEndCall && !this.ended) {
      voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Ending call after STT error phrase');
      this.onCallEnded();
      this.cfg.ws.close();
      return;
    }

    // Normal play completion — resume listening for next user utterance
    if (!this.ended) {
      this.send(JSON.stringify({ type: 'RESUME' }));
      this.resetInactivityTimer();
    }
  }

  private clearSttErrorTimeout(): void {
    if (this.sttErrorTimeout) {
      clearTimeout(this.sttErrorTimeout);
      this.sttErrorTimeout = null;
    }
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.ended) return;
    this.inactivityTimer = setTimeout(() => {
      if (this.ended || this.agentRunning || this.speaking) return;
      voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Inactivity check-in triggered');
      const checkIn =
        this.cfg.language === 'ru'
          ? 'Ты ещё здесь? Могу ещё чем-то помочь?'
          : 'Are you still there? Is there anything else I can help you with?';
      this.rollingTranscript = checkIn;
      this.onEnoughToRespond();
    }, CallSession.INACTIVITY_MS);
  }

  private onCallEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearSttErrorTimeout();
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    this.speaking = false;
    this.pendingErrorPhrase = null;
    this.endCallAfterCurrentPlay = false;
    this.thinking?.cancel();
    this.novaStt?.close();
    this.fluxStt?.close();
    const del = this.cfg.unlink ?? fsUnlink;
    for (const f of this.tmpFiles) {
      del(f).catch(() => {});
    }
    this.tmpFiles.clear();
    voiceLogger.info({ sessionId: this.cfg.sessionId }, 'Call ended, session cleaned up');
  }

  private playErrorPhrase(): void {
    if (this.ended) return;
    const file = `data/call-phrases/${this.cfg.language}/stt_error.ogg`;
    this.clearSttErrorTimeout();
    this.sttErrorTimeout = setTimeout(() => {
      if (!this.ended) {
        voiceLogger.warn(
          { sessionId: this.cfg.sessionId },
          'Force-ending call: PLAY_DONE never arrived after STT error',
        );
        this.cfg.ws.close();
      }
    }, this.cfg.sttErrorTimeoutMs ?? 15_000);
    if (this.lastPlayFile !== null) {
      this.pendingErrorPhrase = file;
    } else {
      this.endCallAfterCurrentPlay = true;
      this.send(JSON.stringify({ type: 'STOP' }));
      this.send(JSON.stringify({ type: 'PLAY', file }));
    }
  }

  private closeSttEpisode(): void {
    this.novaStt?.close();
    this.novaStt = null;
    this.speaking = false;
  }

  private sendPlay(file: string): void {
    if (this.lastPlayFile) {
      const del = this.cfg.unlink ?? fsUnlink;
      del(this.lastPlayFile).catch(() => {});
      this.tmpFiles.delete(this.lastPlayFile);
    }
    this.lastPlayFile = file;
    this.send(JSON.stringify({ type: 'STOP' }));
    this.send(JSON.stringify({ type: 'PLAY', file }));
  }

  private send(data: string): void {
    try {
      this.cfg.ws.send(data);
    } catch (err) {
      voiceLogger.warn({ err }, 'Failed to send WS message');
    }
  }

  private tempFile(): string {
    const file = `/tmp/call-${this.cfg.sessionId}-${++this.fileSeq}.ogg`;
    this.tmpFiles.add(file);
    return file;
  }
}
