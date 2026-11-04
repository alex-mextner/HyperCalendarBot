import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { configureTimeoutReporter, TimeoutReporter } from '../../../src/services/incident/timeout-reporter.ts';
import { CallSession } from '../../../src/services/voice/call-session.ts';
import type { NovaStreamingSTTEvents } from '../../../src/services/voice/nova-streaming-stt.ts';

const alerts: Array<{ text: string; source: string }> = [];
const live: CallSession[] = [];

beforeEach(() => {
  alerts.length = 0;
  spyOn(Bun, 'write').mockImplementation(async () => 0);
  configureTimeoutReporter(
    new TimeoutReporter(
      (text, source) => alerts.push({ text, source }),
      () => 1_000,
    ),
  );
});

afterEach(async () => {
  configureTimeoutReporter(null);
  for (const s of live.splice(0)) await s.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  mock.restore();
});

/** A session whose STT stream fails, so it plays the error phrase and arms the PLAY_DONE watchdog. */
async function failedSttSession(sessionId: string) {
  const close = mock(() => {});
  let events: NovaStreamingSTTEvents | undefined;
  const session = CallSession.create({
    sessionId,
    userId: 42,
    language: 'ru',
    ws: { send: mock(() => {}), close },
    createNovaStt: () => ({
      connect: (e: NovaStreamingSTTEvents) => {
        events = e;
      },
      sendAudio: () => {},
      close: () => {},
    }),
    createFluxStt: () => ({ connect: () => {}, sendAudio: () => {}, close: () => {} }),
    createThinkingPlayer: () => ({ start: () => {}, cancel: () => {} }),
    agent: { run: async () => ({ responseText: '' }) },
    tts: { synthesize: async () => Buffer.from('a') },
    openerText: 'hi',
    unlink: async () => {},
    sttErrorTimeoutMs: 10,
  });
  live.push(session);
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  events?.onError(new Error('stt down'));
  return { close };
}

test('STT error watchdog reports one voice_stt alert and still closes the call', async () => {
  const { close } = await failedSttSession('s1');
  await Bun.sleep(40);
  expect(close).toHaveBeenCalledTimes(1);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.source).toBe('timeout');
  expect(alerts[0]?.text).toContain('Timeout (voice_stt)');
});

test('repeated STT error timeouts inside the window stay one alert', async () => {
  const a = await failedSttSession('s2');
  const b = await failedSttSession('s3');
  await Bun.sleep(40);
  expect(a.close).toHaveBeenCalledTimes(1);
  expect(b.close).toHaveBeenCalledTimes(1);
  expect(alerts).toHaveLength(1);
});

test('no alert when the call ends before the watchdog fires', async () => {
  const { close } = await failedSttSession('s4');
  await live[0]?.handleMessage(JSON.stringify({ type: 'CALL_ENDED' }));
  await Bun.sleep(40);
  expect(close).not.toHaveBeenCalled();
  expect(alerts).toHaveLength(0);
});
