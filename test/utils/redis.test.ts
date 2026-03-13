import { describe, expect, test } from 'bun:test';
import { parseRedisUrl } from '../../src/utils/redis.ts';

describe('parseRedisUrl', () => {
  test('parses standard redis URL', () => {
    expect(parseRedisUrl('redis://localhost:6379')).toEqual({ host: 'localhost', port: 6379 });
  });

  test('parses URL with custom host and port', () => {
    expect(parseRedisUrl('redis://redis.internal:6380')).toEqual({
      host: 'redis.internal',
      port: 6380,
    });
  });

  test('falls back to localhost when hostname resolves empty', () => {
    // URL with empty host section: redis:// followed by path only
    const result = parseRedisUrl('redis:///');
    expect(result.host).toBe('localhost');
    expect(result.port).toBe(6379);
  });

  test('falls back to port 6379 when port is absent', () => {
    const result = parseRedisUrl('redis://myhost');
    expect(result.host).toBe('myhost');
    expect(result.port).toBe(6379);
  });
});
