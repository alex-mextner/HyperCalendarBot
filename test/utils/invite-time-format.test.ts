import { describe, expect, test } from 'bun:test';
import { formatProposedTime } from '../../src/utils/invite-time-format';

describe('formatProposedTime', () => {
  test('formats ISO UTC to readable EN string', () => {
    const result = formatProposedTime('2026-04-01T10:30:00Z', 'UTC', 'en');
    expect(result).toContain('Apr');
    expect(result).toContain('1');
  });

  test('formats ISO UTC to readable RU string', () => {
    const result = formatProposedTime('2026-04-01T10:30:00Z', 'UTC', 'ru');
    expect(result).toMatch(/апр|1 апр/i);
  });

  test('applies timezone offset', () => {
    const utc = formatProposedTime('2026-04-01T10:00:00Z', 'UTC', 'en');
    const kyiv = formatProposedTime('2026-04-01T10:00:00Z', 'Europe/Kyiv', 'en');
    expect(utc).not.toBe(kyiv);
  });
});
