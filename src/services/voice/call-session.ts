// src/services/voice/call-session.ts
import { unlink as fsUnlink } from 'node:fs/promises';
import type { AgentContext } from '../ai/types.ts';
import type { FluxStreamingSTT } from './flux-streaming-stt.ts';
import { classifyInterrupt } from './interruption-classifier.ts';
import type { NovaStreamingSTT } from './nova-streaming-stt.ts';
import type { ThinkingPhrasePlayer } from './thinking-phrase-player.ts';
import { voiceLogger } from './types.ts';

export interface CallSessionConfig {
  sessionId: string;
  userId: number;
  language: 'ru' | 'en';
  ws: { send: (data: string | Buffer) => void; close: () => void };
  createNovaStt: () => NovaStreamingSTT;
  createFluxStt: () => FluxStreamingSTT;
  createThinkingPlayer: () => ThinkingPhrasePlayer;
  agent: { run: (ctx: AgentContext) => Promise<{ responseText?: string }> };
  tts: { synthesize: (text: string, lang: string) => Promise<Buffer> };
  openerText: string;
  agentContextBase?: Partial<AgentContext>;
  unlink?: (path: string) => Promise<void>;
  sttErrorTimeoutMs?: number;
}

export class CallSession {
  private ended = false;
  private speaking = false;
  private agentRunning = false;
  private novaStt: NovaStreamingSTT | null = null;
  private fluxStt: FluxStreamingSTT | null = null;
  private thinking: ThinkingPhrasePlayer | null = null;
  private fileSeq = 0;
  lastPlayFile: string | null = null;
  private tmpFiles = new Set<string>();
  private rollingTranscript = '';
  private pendingErrorPhrase: string | null = null;
  private endCallAfterCurrentPlay = false;
  private sttErrorTimeout: ReturnType<typeof setTimeout> | null = null;

  private constructor(private readonly cfg: CallSessionConfig) {}

  static create(cfg: CallSessionConfig): CallSession {
    return new CallSession(cfg);
  }

  async handleMessage(data: string): Promise<void> {
    if (this.ended) return;
    let msg: { type: string };
    try {
      msg = JSON.parse(data) as { type: string };
    } catch {
      return;
    }

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
    if (!this.speaking) return;
    if (this.cfg.language === 'ru') {
      this.novaStt?.sendAudio(data);
    } else {
      this.fluxStt?.sendAudio(data);
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
        onStartOfTurn: () => {},
        onEndOfTurn: (_confidence: number) => this.onEnoughToRespond(),
        onInterim: (t: string) => {
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
    this.agentRunning = true;

    this.speaking = false;
    this.novaStt?.close();
    this.novaStt = null;

    this.thinking = this.cfg.createThinkingPlayer();
    this.thinking.start((cmd) => this.send(JSON.stringify(cmd)));

    const transcript = this.rollingTranscript;
    this.rollingTranscript = '';

    // TODO: spec requires a 10s fail-open timer — if agent takes longer, resume listening
    this.runAgent(transcript).catch((err) => {
      voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
    });
  }

  private async runAgent(transcript: string): Promise<void> {
    try {
      const ctx = {
        ...(this.cfg.agentContextBase ?? {}),
        user: { telegram_id: this.cfg.userId } as never,
        chatId: this.cfg.userId,
        messageText: transcript,
        inputMode: 'live_call',
        isGroup: false,
      } as AgentContext;

      let responseText: string | undefined;
      try {
        ({ responseText } = await this.cfg.agent.run(ctx));
      } catch (err) {
        voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
        return;
      } finally {
        this.thinking?.cancel();
        this.thinking = null;
      }

      if (!responseText) return;

      try {
        const audio = await this.cfg.tts.synthesize(responseText, this.cfg.language);
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
    }
  }

  private clearSttErrorTimeout(): void {
    if (this.sttErrorTimeout) {
      clearTimeout(this.sttErrorTimeout);
      this.sttErrorTimeout = null;
    }
  }

  private onCallEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearSttErrorTimeout();
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
