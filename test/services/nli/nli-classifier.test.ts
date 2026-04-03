import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NliClassifier } from '../../../src/services/nli/nli-classifier.ts';

const CALENDAR_LABEL = 'calendar scheduling reminder event meeting';

describe('NliClassifier', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(calendarScore: number, generalScore: number) {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sequence: 'test',
            labels: [CALENDAR_LABEL, 'general conversation chat smalltalk'],
            scores: [calendarScore, generalScore],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof globalThis.fetch;
  }

  test('returns true when calendar score >= 0.4', async () => {
    mockFetch(0.7, 0.3);
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('Запланируй встречу на завтра')).toBe(true);
  });

  test('returns false when calendar score < 0.4', async () => {
    mockFetch(0.2, 0.8);
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('Как дожить до 12 апреля')).toBe(false);
  });

  test('returns true on API error (fail open)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('error', { status: 500 })),
    ) as unknown as typeof globalThis.fetch;
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('some text')).toBe(true);
  });

  test('returns true on network error (fail open)', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('network down'))) as unknown as typeof globalThis.fetch;
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('some text')).toBe(true);
  });

  test('returns true on timeout (fail open)', async () => {
    globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('ok')), 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }) as unknown as typeof globalThis.fetch;
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('some text')).toBe(true);
  });

  test('returns true on malformed response (fail open)', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    ) as unknown as typeof globalThis.fetch;
    const classifier = new NliClassifier('test-token');
    expect(await classifier.isCalendarRelated('some text')).toBe(true);
  });

  test('sends correct Authorization header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            sequence: 'test',
            labels: [CALENDAR_LABEL, 'general conversation chat smalltalk'],
            scores: [0.8, 0.2],
          }),
          { status: 200 },
        ),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const classifier = new NliClassifier('my-secret-token');
    await classifier.isCalendarRelated('test');

    const callArgs = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = callArgs[1].headers as { [key: string]: string };
    expect(headers.Authorization).toBe('Bearer my-secret-token');
  });
});
