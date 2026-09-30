import { expect, type Mock, mock, test } from 'bun:test';
import { FluxStreamingSTT } from '../../../src/services/voice/flux-streaming-stt.ts';
import type { SttSocket } from '../../../src/services/voice/types.ts';

interface WsMock extends SttSocket {
  readyState: number;
  send: Mock<(data: string | Buffer) => void>;
  close: Mock<() => void>;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

function makeWsMock(): WsMock {
  return {
    readyState: WebSocket.OPEN,
    send: mock((_data: string | Buffer) => {}),
    close: mock(() => {}),
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}

function message(data: string): MessageEvent {
  return new MessageEvent('message', { data });
}

test('builds Flux URL with correct params', () => {
  let capturedUrl = '';
  const stt = new FluxStreamingSTT('test-key', {
    createWs: (url) => {
      capturedUrl = url;
      return makeWsMock();
    },
  });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  expect(capturedUrl).toContain('model=flux-general-en');
  expect(capturedUrl).toContain('sample_rate=16000');
  expect(capturedUrl).toContain('eot_threshold=0.7');
});

test('emits onStartOfTurn when Flux sends StartOfTurn event', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  const onStartOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.(message(JSON.stringify({ type: 'TurnInfo', event: 'StartOfTurn' })));

  expect(onStartOfTurn).toHaveBeenCalledTimes(1);
});

test('emits onEndOfTurn with confidence and final transcript', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  const onEndOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.(
    message(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        end_of_turn_confidence: 0.85,
        transcript: 'hello world',
      }),
    ),
  );

  expect(onEndOfTurn).toHaveBeenCalledWith(0.85, 'hello world');
});

test('emits onEndOfTurn with empty string when no transcript', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  const onEndOfTurn = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn, onInterim: () => {}, onError: () => {} });

  ws.onmessage?.(message(JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', end_of_turn_confidence: 0.72 })));

  expect(onEndOfTurn).toHaveBeenCalledWith(0.72, '');
});

test('emits onInterim for regular transcript', () => {
  const ws = makeWsMock();
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  const onInterim = mock(() => {});
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim, onError: () => {} });

  ws.onmessage?.(
    message(
      JSON.stringify({
        type: 'TurnInfo',
        event: 'Update',
        transcript: 'hello',
      }),
    ),
  );

  expect(onInterim).toHaveBeenCalledWith('hello');
});

test('onerror fires onError with message and readyState', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onerror?.(new ErrorEvent('error', { message: 'connection refused' }));

  expect(onError).toHaveBeenCalledTimes(1);
  const err = onError.mock.calls[0]![0];
  expect(err.message).toContain('connection refused');
  expect(err.message).toContain('readyState=');
});

test('onclose fires onError for non-1000 code', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onclose?.(new CloseEvent('close', { code: 1008, reason: 'Unauthorized' }));

  expect(onError).toHaveBeenCalledTimes(1);
  const err = onError.mock.calls[0]![0];
  expect(err.message).toContain('code=1008');
  expect(err.message).toContain('Unauthorized');
});

test('onclose with code=1000 does not fire onError', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onclose?.(new CloseEvent('close', { code: 1000, reason: '' }));

  expect(onError).not.toHaveBeenCalled();
});

test('onerror and onclose together fire onError only once', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError });

  ws.onerror?.(new Event('error'));
  ws.onclose?.(new CloseEvent('close', { code: 1006, reason: '' }));

  expect(onError).toHaveBeenCalledTimes(1);
});

test('does not send audio when closed', () => {
  const ws = makeWsMock();
  ws.readyState = 3;
  const stt = new FluxStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onStartOfTurn: () => {}, onEndOfTurn: () => {}, onInterim: () => {}, onError: () => {} });
  stt.sendAudio(Buffer.from([1, 2]));
  expect(ws.send).not.toHaveBeenCalled();
});
