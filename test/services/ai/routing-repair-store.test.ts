import { describe, expect, test } from 'bun:test';
import { InMemoryRoutingRepairStore, RedisRoutingRepairStore } from '../../../src/services/ai/routing-repair-store.ts';

describe('routing repair state', () => {
  test('in-memory state is scoped by chat+user and clears explicitly', async () => {
    const s = new InMemoryRoutingRepairStore(1000);
    await s.open(1, 2);
    expect(await s.isOpen(1, 2)).toBe(true);
    expect(await s.isOpen(1, 3)).toBe(false);
    expect(await s.isOpen(2, 2)).toBe(false);
    await s.clear(1, 2);
    expect(await s.isOpen(1, 2)).toBe(false);
  });
  test('redis store uses an expiring scoped key', async () => {
    const values = new Map<string, string>();
    let args: unknown[] = [];
    const redis = {
      get: async (k: string) => values.get(k) ?? null,
      set: async (k: string, v: string, ...rest: unknown[]) => {
        values.set(k, v);
        args = rest;
        return 'OK';
      },
      del: async (k: string) => {
        values.delete(k);
        return 1;
      },
    };
    const s = new RedisRoutingRepairStore(redis, 900);
    await s.open(-100, 42);
    expect(await s.isOpen(-100, 42)).toBe(true);
    expect(args).toEqual(['EX', 900]);
    await s.clear(-100, 42);
    expect(await s.isOpen(-100, 42)).toBe(false);
  });
  test('rejects unbounded TTL', () => {
    const redis = { get: async () => null, set: async () => null, del: async () => 0 };
    expect(() => new RedisRoutingRepairStore(redis, 0)).toThrow('INVALID_REPAIR_TTL');
  });
});
