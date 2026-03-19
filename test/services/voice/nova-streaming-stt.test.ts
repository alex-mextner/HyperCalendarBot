import { expect, mock, test } from 'bun:test';
import { NovaStreamingSTT } from '../../../src/services/voice/nova-streaming-stt.ts';

function makeWsMock() {
  const ws = {
    readyState: 1, // OPEN
    send: mock(() => {}),
    close: mock(() => {}),
    onmessage: null as ((e: { data: string }) => void) | null,
    onerror: null as ((e: unknown) => void) | null,
    onclose: null as (() => void) | null,
    onopen: null as (() => void) | null,
  };
  return ws;
}

test('builds correct Deepgram URL with Nova-3 params', () => {
  let capturedUrl = '';
  const stt = new NovaStreamingSTT('test-api-key', {
    createWs: (url: string) => {
      capturedUrl = url;
      return makeWsMock() as unknown as WebSocket;
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
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  const pcm = Buffer.from([1, 2, 3, 4]);
  stt.sendAudio(pcm);

  expect(ws.send).toHaveBeenCalledWith(pcm);
});

test('emits interim transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onInterim = mock(() => {});
  stt.connect({ onInterim, onFinal: () => {}, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: false,
      channel: { alternatives: [{ transcript: 'привет' }] },
    }),
  });

  expect(onInterim).toHaveBeenCalledWith('привет');
});

test('emits final transcript from Deepgram message', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  const onFinal = mock(() => {});
  stt.connect({ onInterim: () => {}, onFinal, onError: () => {} });

  ws.onmessage?.({
    data: JSON.stringify({
      is_final: true,
      channel: { alternatives: [{ transcript: 'добрый день' }] },
    }),
  });

  expect(onFinal).toHaveBeenCalledWith('добрый день');
});

test('does not send audio when WS is not open', () => {
  const ws = makeWsMock();
  ws.readyState = 3; // CLOSED
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });

  stt.sendAudio(Buffer.from([1, 2, 3]));

  expect(ws.send).not.toHaveBeenCalled();
});

test('close sends CloseStream and nulls ws', () => {
  const ws = makeWsMock();
  const stt = new NovaStreamingSTT('key', { createWs: () => ws as unknown as WebSocket });
  stt.connect({ onInterim: () => {}, onFinal: () => {}, onError: () => {} });
  stt.close();

  expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'CloseStream' }));
});
