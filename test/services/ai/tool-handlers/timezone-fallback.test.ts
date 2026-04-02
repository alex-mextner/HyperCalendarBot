// test/services/ai/tool-handlers/timezone-fallback.test.ts
import { describe, expect, mock, test } from 'bun:test';

// Mock resolveCity before importing the module under test
const resolveCityMock = mock(() => Promise.resolve(null as string | null));
mock.module('../../../../src/services/timezone/city-resolver.ts', () => ({
  resolveCity: resolveCityMock,
}));

const { handleGetTimezoneInfoWithCityFallback } = await import(
  '../../../../src/services/ai/tool-handlers/timezone.ts'
);

describe('handleGetTimezoneInfoWithCityFallback', () => {
  test('valid IANA timezone returns synchronously without resolveCity', async () => {
    resolveCityMock.mockClear();
    const result = await handleGetTimezoneInfoWithCityFallback({ timezone: 'Europe/London' });
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('Europe/London');
    expect(resolveCityMock).not.toHaveBeenCalled();
  });

  test('city name falls through to resolveCity and returns resolved timezone', async () => {
    resolveCityMock.mockClear();
    resolveCityMock.mockResolvedValueOnce('America/New_York');

    const result = await handleGetTimezoneInfoWithCityFallback(
      { timezone: 'Miami', at: '2026-01-15T12:00:00Z' },
      'test-model',
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output!);
    expect(data.timezone).toBe('America/New_York');
    expect(resolveCityMock).toHaveBeenCalledWith('Miami', 'test-model');
  });

  test('array of timezones does not attempt city resolution', async () => {
    resolveCityMock.mockClear();
    const result = await handleGetTimezoneInfoWithCityFallback({
      timezone: ['Europe/Moscow', 'Invalid/Blah'],
    });
    expect(result.success).toBe(false);
    expect(resolveCityMock).not.toHaveBeenCalled();
  });

  test('resolveCity returning null preserves original error', async () => {
    resolveCityMock.mockClear();
    resolveCityMock.mockResolvedValueOnce(null);

    const result = await handleGetTimezoneInfoWithCityFallback({ timezone: 'Неизвестный город' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid timezone');
    expect(resolveCityMock).toHaveBeenCalledWith('Неизвестный город', undefined);
  });
});
