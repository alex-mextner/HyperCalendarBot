export interface FluxStreamingSTTEvents {
  onStartOfTurn: () => void;
  onEndOfTurn: (confidence: number) => void;
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
    const params = new URLSearchParams({
      model: 'flux-general-en',
      eot_threshold: '0.7',
      eot_timeout_ms: '5000',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
    });
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    const createWs =
      this.deps.createWs ?? ((u) => new WebSocket(u, { headers: { Authorization: `Token ${this.apiKey}` } } as never));
    this.ws = createWs(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          type?: string;
          end_of_turn_confidence?: number;
          is_final?: boolean;
          channel?: { alternatives?: { transcript: string }[] };
        };
        if (data.type === 'StartOfTurn') {
          events.onStartOfTurn();
          return;
        }
        if (data.type === 'EndOfTurn') {
          events.onEndOfTurn(data.end_of_turn_confidence ?? 1.0);
          return;
        }
        const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (transcript) events.onInterim(transcript);
      } catch {
        // non-JSON keepalive
      }
    };

    this.ws.onerror = () => events.onError(new Error('Flux WebSocket error'));
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
      this.ws = null;
    }
  }
}
