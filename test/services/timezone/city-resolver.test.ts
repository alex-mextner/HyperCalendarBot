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

const { resolveCity } = await import('../../../src/services/timezone/city-resolver.ts');

describe('resolveCity', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'Europe/Belgrade' }] });
  });

  test('returns IANA key when user types it directly', async () => {
    expect(await resolveCity('Europe/Belgrade')).toBe('Europe/Belgrade');
  });

  test('resolves Latin city name via library', async () => {
    const result = await resolveCity('Belgrade');
    expect(result).toBe('Europe/Belgrade');
  });

  test('resolves partial/fuzzy city name via library', async () => {
    const result = await resolveCity('New Yor');
    expect(result).toBeTruthy();
    expect(result).toContain('America/');
  });

  test('resolves Russian nominative via matcher without AI', async () => {
    expect(await resolveCity('москва')).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves Russian case forms via matcher without AI', async () => {
    expect(await resolveCity('москве')).toBe('Europe/Moscow');
    expect(await resolveCity('нижнем новгороде')).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves abbreviations without AI', async () => {
    expect(await resolveCity('мск')).toBe('Europe/Moscow');
    expect(await resolveCity('екб')).toBe('Asia/Yekaterinburg');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves case-insensitive', async () => {
    expect(await resolveCity('Москве')).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('falls back to AI for unknown input', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Moscow' }] });
    const result = await resolveCity('глубокобыстрицк');
    expect(result).toBe('Europe/Moscow');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('resolves when AI returns a city name instead of IANA key', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Belgrade' }] });
    const result = await resolveCity('глубокобыстрицк');
    expect(result).toBe('Europe/Belgrade');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('returns null when AI response has empty content', async () => {
    mockCreate.mockResolvedValueOnce({ content: [] });
    const result = await resolveCity('глубокобыстрицк');
    expect(result).toBeNull();
  });

  test('AI makes only 1 attempt to avoid long delays', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Fake/Zone' }] });
    const result = await resolveCity('глубокобыстрицк');
    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('returns null when AI returns UNKNOWN', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'UNKNOWN' }] });
    const result = await resolveCity('asdfasdf');
    expect(result).toBeNull();
  });

  test('resolves relocant destination cities', async () => {
    expect(await resolveCity('батуми')).toBe('Asia/Tbilisi');
    expect(await resolveCity('будве')).toBe('Europe/Podgorica');
    expect(await resolveCity('лимасоле')).toBe('Asia/Nicosia');
    expect(await resolveCity('анталье')).toBe('Europe/Istanbul');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('resolves воронеж without AI (now in matcher)', async () => {
    expect(await resolveCity('воронеже')).toBe('Europe/Moscow');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
