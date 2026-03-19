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

  test('resolves partial/fuzzy city name', async () => {
    const result = await resolveCity('New Yor');
    expect(result).toBeTruthy();
    expect(result).toContain('America/');
  });

  test('falls back to AI for Cyrillic input', async () => {
    // Cyrillic 'Белград' won't match in city-timezones library → goes to AI
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Europe/Belgrade' }] });
    const result = await resolveCity('Белград');
    expect(result).toBe('Europe/Belgrade');
    expect(mockCreate).toHaveBeenCalledTimes(1);
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
});
