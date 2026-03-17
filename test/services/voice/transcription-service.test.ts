import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { TranscriptionService } from '../../../src/services/voice/transcription-service.ts';

const originalFetch = globalThis.fetch;

describe('TranscriptionService', () => {
  let service: TranscriptionService;

  beforeEach(() => {
    service = new TranscriptionService('hf_test_token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends audio buffer to HF Inference API and returns text', async () => {
    const audioBuffer = Buffer.from('fake-ogg-data');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toContain('whisper-large-v3-turbo');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer hf_test_token',
          'Content-Type': 'audio/ogg',
        }),
      );
      return new Response(JSON.stringify({ text: ' Привет, создай встречу на завтра ' }));
    }) as typeof fetch;

    const result = await service.transcribe(audioBuffer);
    expect(result).toBe('Привет, создай встречу на завтра');
  });

  test('throws on HTTP error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Service unavailable', { status: 503 });
    }) as typeof fetch;

    await expect(service.transcribe(Buffer.from('data'))).rejects.toThrow('HTTP 503');
  });

  test('returns empty string when API returns empty text', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ text: '' }));
    }) as typeof fetch;

    const result = await service.transcribe(Buffer.from('data'));
    expect(result).toBe('');
  });

  test('returns empty string when API returns no text field', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    const result = await service.transcribe(Buffer.from('data'));
    expect(result).toBe('');
  });
});
