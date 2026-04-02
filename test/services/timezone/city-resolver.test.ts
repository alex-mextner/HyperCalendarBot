// test/services/timezone/city-resolver.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock Anthropic before importing resolver
const mockCreate = mock(async () => ({
  content: [{ type: 'text', text: 'Europe/Belgrade' }],
}));
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

const { resolveCity, clearResolveCache } = await import('../../../src/services/timezone/city-resolver.ts');

describe('resolveCity', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Europe/Belgrade' }] });
    clearResolveCache();
  });

  test('returns IANA key when user types it directly', async () => {
    expect(await resolveCity('Europe/Belgrade')).toBe('Europe/Belgrade');
  });

  test('resolves Latin city name via library', async () => {
    const result = await resolveCity('Belgrade');
    expect(result).toBe('Europe/Belgrade');
  });

  test('resolves partial/fuzzy city name', async () => {
    const result = await resolveCity('New Yor');
    expect(result).toBeTruthy();
    expect(result).toContain('America/');
  });

  test('falls back to AI for Cyrillic input not in dictionary', async () => {
    // Cyrillic 'Воронеж' not in dictionary or library → goes to AI
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Moscow' }] });
    const result = await resolveCity('Воронеж');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('resolves when AI returns a city name instead of IANA key (libFallback path)', async () => {
    // Cyrillic input → dictionary misses → library misses → AI returns 'Belgrade' (city name)
    // validateTimezone('Belgrade') is false → lookupLibrary('Belgrade') → 'Europe/Belgrade'
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Belgrade' }] });
    const result = await resolveCity('Воронеж');
    expect(result).toBe('Europe/Belgrade');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('returns null when AI response has empty content', async () => {
    mockCreate.mockResolvedValueOnce({ content: [] });
    const result = await resolveCity('Воронеж');
    expect(result).toBeNull();
  });

  test('retries AI when it returns invalid IANA key', async () => {
    // Use Cyrillic so library won't resolve it
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Novi_Sad' }] }) // invalid
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Belgrade' }] }); // valid
    const result = await resolveCity('Нови Сад');
    expect(result).toBe('Europe/Belgrade');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  test('returns null after 3 exhausted AI attempts', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Fake/Zone' }] });
    const result = await resolveCity('xyzxyzxyz');
    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  test('returns null when AI returns UNKNOWN', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'UNKNOWN' }] });
    const result = await resolveCity('asdfasdf');
    expect(result).toBeNull();
  });

  test('resolves Russian case forms from dictionary without AI', async () => {
    // "москве" (prepositional case) should resolve instantly via dictionary
    const result = await resolveCity('москве');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves nominative Russian city from dictionary without AI', async () => {
    const result = await resolveCity('москва');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves abbreviation from dictionary without AI', async () => {
    const result = await resolveCity('мск');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves case-insensitive dictionary lookup', async () => {
    const result = await resolveCity('Москве');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('caches AI resolution and reuses on second call', async () => {
    // Use a city not in dictionary to force AI path
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Moscow' }] });
    const first = await resolveCity('Краснодар');
    expect(first).toBe('Europe/Moscow');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    mockCreate.mockReset();
    const second = await resolveCity('Краснодар');
    expect(second).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
