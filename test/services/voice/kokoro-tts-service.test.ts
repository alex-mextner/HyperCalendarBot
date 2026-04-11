import { expect, mock, test } from 'bun:test';
import type { InferenceClient } from '@huggingface/inference';
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

// Install a fake HF client onto the service without `as any`.
// The real client type is large and only textToSpeech is used here.
function attachFakeClient(svc: KokoroTtsService, blob: Blob): void {
  const fakeClient: Partial<InferenceClient> = {
    textToSpeech: mock(async () => blob),
  };
  (svc as unknown as { client: Partial<InferenceClient> }).client = fakeClient;
}

test('synthesize converts WAV from HF API to OGG Opus buffer', async () => {
  const wavBuffer = makeWavBuffer();
  const fakeBlob = new Blob([wavBuffer], { type: 'audio/wav' });
  // Injected converter writes a fake OGG file with the correct magic header.
  const convertWavToOgg = mock(async (_wav: string, ogg: string) => {
    const oggBytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(100)]);
    await Bun.write(ogg, oggBytes);
    return { ok: true };
  });

  const svc = new KokoroTtsService('fake-token', convertWavToOgg);
  attachFakeClient(svc, fakeBlob);

  const result = await svc.synthesize('hello');

  expect(convertWavToOgg).toHaveBeenCalledTimes(1);
  // OGG Opus magic bytes: OggS
  expect(result.slice(0, 4).toString('ascii')).toBe('OggS');
  expect(result.length).toBeGreaterThan(0);
});

test('synthesize throws if ffmpeg fails', async () => {
  const fakeBlob = new Blob([Buffer.from('not-a-wav')], { type: 'audio/wav' });
  const convertWavToOgg = mock(() =>
    Promise.resolve({ ok: false, exitCode: 1, stderr: 'Invalid data found when processing input' }),
  );

  const svc = new KokoroTtsService('fake-token', convertWavToOgg);
  attachFakeClient(svc, fakeBlob);

  await expect(svc.synthesize('hello')).rejects.toThrow('ffmpeg WAV→OGG failed');
});
