import { expect, type Mock, mock, test } from 'bun:test';
import { NovaStreamingSTT } from '../../../src/services/voice/nova-streaming-stt.ts';
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

test('builds correct Deepgram URL with Nova-3 params', () => {
  let capturedUrl = '';
  const stt = new NovaStreamingSTT('test-api-key', {
    createWs: (url: string) => {
      capturedUrl = url;
      return makeWsMock();
    },
  });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });
  expect(capturedUrl).toContain('wss://api.deepgram.com/v1/listen');
  expect(capturedUrl).toContain('model=nova-3');
  expect(capturedUrl).toContain('language=ru');
  expect(capturedUrl).toContain('sample_rate=48000');
  expect(capturedUrl).toContain('interim_results=true');
});

test('sends PCM buffer to WebSocket', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  const pcm = Buffer.from([1, 2, 3, 4]);
  stt.sendAudio(pcm);

  expect(ws.send).toHaveBeenCalledWith(pcm);
});

test('emits interim transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  const onInterim = mock(() => {});
  stt.connect({ onInterim, onFinal: () => {}, onError: () => {} });

  ws.onmessage?.(
    message(
      JSON.stringify({
        is_final: false,
        channel: { alternatives: [{ transcript: 'привет' }] },
      }),
    ),
  );

  expect(onInterim).toHaveBeenCalledWith('привет');
});

test('emits final transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  const onFinal = mock(() => {});
  stt.connect({ onInterim: () => {}, onFinal, onError: () => {} });

  ws.onmessage?.(
    message(
      JSON.stringify({
        is_final: true,
        channel: { alternatives: [{ transcript: 'добрый день' }] },
      }),
    ),
  );

  expect(onFinal).toHaveBeenCalledWith('добрый день');
});

test('does not send audio when WS is not open', () => {
  const ws = makeWsMock();
  ws.readyState = 3; // CLOSED
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  stt.sendAudio(Buffer.from([1, 2, 3]));

  expect(ws.send).not.toHaveBeenCalled();
});

test('onerror fires onError with message and readyState', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError });

  ws.onerror?.(new ErrorEvent('error', { message: 'connection refused' }));

  expect(onError).toHaveBeenCalledTimes(1);
  const err = onError.mock.calls[0]![0];
  expect(err.message).toContain('connection refused');
  expect(err.message).toContain('readyState=');
});

test('onclose fires onError for non-1000 code', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError });

  ws.onclose?.(new CloseEvent('close', { code: 1008, reason: 'Unauthorized' }));

  expect(onError).toHaveBeenCalledTimes(1);
  const err = onError.mock.calls[0]![0];
  expect(err.message).toContain('code=1008');
  expect(err.message).toContain('Unauthorized');
});

test('onclose with code=1000 does not fire onError', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError });

  ws.onclose?.(new CloseEvent('close', { code: 1000, reason: '' }));

  expect(onError).not.toHaveBeenCalled();
});

test('onerror and onclose together fire onError only once', () => {
  const ws = makeWsMock();
  const onError = mock((_e: Error) => {});
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError });

  ws.onerror?.(new Event('error'));
  ws.onclose?.(new CloseEvent('close', { code: 1006, reason: '' }));

  expect(onError).toHaveBeenCalledTimes(1);
});

test('close sends CloseStream and nulls ws', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });
  stt.close();

  expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
});
