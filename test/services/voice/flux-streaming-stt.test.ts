import { expect, mock, test } from 'bun:test';
import { FluxStreamingSTT } from '../../../src/services/voice/flux-streaming-stt.ts';

function makeWsMock() {
  return {
    readyState: 1,
    send: mock(() => {}),
    close: mock(() => {}),
    onmessage: null as ((e: { data: string }) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    onclose: null as ((e: CloseEvent) => void) | null,
    onopen: null as (() => void) | null,
  };
}

test('builds Flux URL with correct params', () => {
  let capturedUrl = '';
  const stt = new FluxStreamingSTT('test-key', {
    createWs: (url) => {
      capturedUrl = url;
      return makeWsMock() as unknown as WebSocket;
    },
  });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  expect(capturedUrl).toContain('model=flux-general-en');
  expect(capturedUrl).toContain('sample_rate=16000');
  expect(capturedUrl).toContain('eot_threshold=0.7');
});

test('emits onStartOfTurn when Flux sends StartOfTurn event', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onStartOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.({ data: JSON.stringify({ type: 'StartOfTurn' }) });

  expect(onStartOfTurn).toHaveBeenCalledTimes(1);
});

test('emits onEndOfTurn when Flux sends EndOfTurn event', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onEndOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.({ data: JSON.stringify({ type: 'EndOfTurn', end_of_turn_confidence: 0.85 }) });

  expect(onEndOfTurn).toHaveBeenCalledWith(0.85);
});

test('emits onInterim for regular transcript', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onInterim = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: false,
      channel: { alternatives: [{ transcript: 'hello' }] },
    }),
  });

  expect(onInterim).toHaveBeenCalledWith('hello');
});

test('onerror fires onError with message and readyState', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onerror?.({ type: 'error', message: 'connection refused' } as unknown as Event);

  expect(onError).toHaveBeenCalledTimes(1);
  expect((onError.mock.calls[0]![0] as Error).message).toContain('connection refused');
  expect((onError.mock.calls[0]![0] as Error).message).toContain('readyState=');
});

test('onclose fires onError for non-1000 code', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onclose?.({ code: 1008, reason: 'Unauthorized' } as CloseEvent);

  expect(onError).toHaveBeenCalledTimes(1);
  expect((onError.mock.calls[0]![0] as Error).message).toContain('code=1008');
  expect((onError.mock.calls[0]![0] as Error).message).toContain('Unauthorized');
});

test('onclose with code=1000 does not fire onError', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);

  expect(onError).not.toHaveBeenCalled();
});

test('onerror and onclose together fire onError only once', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onerror?.({ type: 'error' } as Event);
  ws.onclose?.({ code: 1006, reason: '' } as CloseEvent);

  expect(onError).toHaveBeenCalledTimes(1);
});

test('does not send audio when closed', () => {
  const ws = makeWsMock();
  ws.readyState = 3;
  const stt = new FluxStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  stt.sendAudio(Buffer.from([1, 2]));
  expect(ws.send).not.toHaveBeenCalled();
});
