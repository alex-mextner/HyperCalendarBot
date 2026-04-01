import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { TranscriptionService } from '../../../src/services/voice/transcription-service.ts';

const originalFetch = globalThis.fetch;

describe('TranscriptionService', () => {
  let service: TranscriptionService;

  beforeEach(() => {
    service = new TranscriptionService('gsk_test_token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends audio to Groq Whisper API via multipart form and returns text', async () => {
    const audioBuffer = Buffer.from('fake-ogg-data');

    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      expect(urlStr).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');

      const headers = init?.headers as { [key: string]: string };
      expect(headers.Authorization).toBe('Bearer gsk_test_token');

      const body = init?.body as FormData;
      expect(body.get('model')).toBe('whisper-large-v3');
      expect(body.get('response_format')).toBe('json');

      const file = body.get('file') as Blob;
      expect(file).toBeInstanceOf(Blob);
      expect(file.type).toBe('audio/ogg');

      return new Response(JSON.stringify({ text: ' Привет, создай встречу на завтра ' }));
    }) as unknown as typeof fetch;

    const result = await service.transcribe(audioBuffer);
    expect(result).toBe('Привет, создай встречу на завтра');
  });

  test('throws on HTTP error', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('Service unavailable', { status: 503 });
    }) as unknown as typeof fetch;

    await expect(service.transcribe(Buffer.from('data'))).rejects.toThrow('HTTP 503');
  });

  test('returns empty string when API returns empty text', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ text: '' }));
    }) as unknown as typeof fetch;

    const result = await service.transcribe(Buffer.from('data'));
    expect(result).toBe('');
  });

  test('returns empty string when API returns no text field', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;

    const result = await service.transcribe(Buffer.from('data'));
    expect(result).toBe('');
  });
});
