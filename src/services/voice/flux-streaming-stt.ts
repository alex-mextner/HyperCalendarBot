export interface FluxStreamingSTTEvents {
  onStartOfTurn: () => void;
  onEndOfTurn: (confidence: number, transcript: string) => void;
  onInterim: (transcript: string) => void;
  onError: (err: Error) => void;
}

export interface FluxStreamingSTTDeps {
  createWs?: (url: string) => WebSocket;
}

export class FluxStreamingSTT {
  private ws: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly deps: FluxStreamingSTTDeps = {},
  ) {}

  connect(events: FluxStreamingSTTEvents): void {
    let errorFired = false;
    const fireError = (err: Error) => {
      if (errorFired) return;
      errorFired = true;
      events.onError(err);
    };
    const params = new URLSearchParams({
      model: 'flux-general-en',
      eot_threshold: '0.7',
      eot_timeout_ms: '5000',
      encoding: 'linear16',
      sample_rate: '16000',
    });
    const url = `wss://api.deepgram.com/v2/listen?${params}`;
    const createWs =
      this.deps.createWs ?? ((u) => new WebSocket(u, { headers: { Authorization: `Token ${this.apiKey}` } }));
    this.ws = createWs(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        // Flux uses ListenV2TurnInfo with an `event` sub-field; connection
        // confirmation arrives as ListenV2Connected (ignored here).
        const data = JSON.parse(event.data as string) as {
          type?: string;
          event?: string;
          transcript?: string;
          end_of_turn_confidence?: number;
        };
        if (data.type !== 'TurnInfo') return;
        if (data.event === 'StartOfTurn') {
          events.onStartOfTurn();
          return;
        }
        if (data.event === 'EndOfTurn') {
          events.onEndOfTurn(data.end_of_turn_confidence ?? 1.0, data.transcript ?? '');
          return;
        }
        // Update / EagerEndOfTurn — emit interim transcript
        const transcript = data.transcript ?? '';
        if (transcript) events.onInterim(transcript);
      } catch {
        // non-JSON keepalive
      }
    };

    this.ws.onerror = (event: Event) => {
      const msg = (event as ErrorEvent).message ?? 'unknown';
      fireError(new Error(`Flux WebSocket error: ${msg} (readyState=${this.ws?.readyState})`));
    };

    this.ws.onclose = (event: CloseEvent) => {
      if (event.code !== 1000) {
        fireError(new Error(`Flux WebSocket closed: code=${event.code} reason=${event.reason || '(none)'}`));
      }
    };
  }

  sendAudio(pcm: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm);
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {}
      this.ws.close();
      this.ws = null;
    }
  }
}
