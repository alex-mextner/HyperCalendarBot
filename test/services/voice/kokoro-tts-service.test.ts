import { expect, mock, test } from 'bun:test';
import { KokoroTtsService } from '../../../src/services/voice/kokoro-tts-service.ts';

// Minimal WAV header: RIFF + WAVE + fmt + data chunks (44 bytes + silence)
function makeWavBuffer(): Buffer {
  const pcmSamples = 480; // 10ms of silence at 48kHz
  const dataSize = pcmSamples * 2; // s16le
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24); // sample rate
  buf.writeUInt32LE(48000, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

// OGG Opus magic-bytes stub — a minimal buffer that satisfies the
// "result starts with OggS" assertion without actually running ffmpeg.
function makeOggStub(): Buffer {
  const buf = Buffer.alloc(32);
  buf.write('OggS', 0);
  return buf;
}

test('synthesize converts WAV from HF API to OGG Opus buffer', async () => {
  const wavBuffer = makeWavBuffer();
  const fakeBlob = new Blob([wavBuffer], { type: 'audio/wav' });

  const spawnFfmpeg = mock((cmd: string[], _opts: { stderr: 'pipe' }) => {
    // Stub: pretend ffmpeg succeeded. The service then reads tmpOgg
    // from disk, so pre-populate it with a minimal OGG-magic buffer.
    const tmpOgg = cmd[cmd.length - 1]!;
    Bun.write(tmpOgg, makeOggStub());
    return {
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
    };
  });

  const svc = new KokoroTtsService('fake-token', { spawnFfmpeg });
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (svc as any).client = {
    textToSpeech: mock(async () => fakeBlob),
  };

  const result = await svc.synthesize('hello');

  expect(spawnFfmpeg).toHaveBeenCalledTimes(1);
  // OGG Opus magic bytes: OggS
  expect(result.slice(0, 4).toString('ascii')).toBe('OggS');
  expect(result.length).toBeGreaterThan(0);
});

test('synthesize throws if ffmpeg fails', async () => {
  const fakeBlob = new Blob([Buffer.from('not-a-wav')], { type: 'audio/wav' });

  const spawnFfmpeg = mock(() => ({
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('Invalid data found when processing input'));
        c.close();
      },
    }),
    exited: Promise.resolve(1),
  }));

  const svc = new KokoroTtsService('fake-token', { spawnFfmpeg });
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (svc as any).client = {
    textToSpeech: mock(async () => fakeBlob),
  };

  await expect(svc.synthesize('hello')).rejects.toThrow('ffmpeg WAV→OGG failed');
});
