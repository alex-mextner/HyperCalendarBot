export interface NovaStreamingSTTEvents {
  onInterim: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (err: Error) => void;
}

export interface NovaStreamingSTTDeps {
  createWs?: (url: string) => WebSocket;
}

export class NovaStreamingSTT {
  private ws: WebSocket | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly deps: NovaStreamingSTTDeps = {},
  ) {}

  connect(events: NovaStreamingSTTEvents): void {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'ru',
      punctuate: 'true',
      smart_format: 'true',
      encoding: 'linear16',
      sample_rate: '48000',
      channels: '1',
      interim_results: 'true',
    });
    const url = `wss://api.deepgram.com/v1/listen?${params}`;
    const createWs =
      this.deps.createWs ?? ((u) => new WebSocket(u, { headers: { Authorization: `Token ${this.apiKey}` } }));
    this.ws = createWs(url);

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as {
          is_final: boolean;
          channel?: { alternatives?: { transcript: string }[] };
        };
        const transcript = data.channel?.alternatives?.[0]?.transcript ?? '';
        if (!transcript) return;
        if (data.is_final) events.onFinal(transcript);
        else events.onInterim(transcript);
      } catch {
        // non-JSON keepalive
      }
    };

    let errorFired = false;
    const fireError = (err: Error) => {
      if (errorFired) return;
      errorFired = true;
      events.onError(err);
    };

    this.ws.onerror = (event: Event) => {
      const msg = (event as ErrorEvent).message ?? 'unknown';
      fireError(new Error(`Nova-3 WebSocket error: ${msg} (readyState=${this.ws?.readyState})`));
    };

    this.ws.onclose = (event: CloseEvent) => {
      if (event.code !== 1000) {
        fireError(new Error(`Nova-3 WebSocket closed: code=${event.code} reason=${event.reason || '(none)'}`));
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
