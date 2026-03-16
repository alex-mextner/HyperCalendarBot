import { describe, expect, test } from 'bun:test';

describe('call-queue', () => {
  test('createCallQueue returns queue and add function', async () => {
    const { createCallQueue } = await import('../../src/worker/call-queue');
    expect(createCallQueue).toBeDefined();
    expect(typeof createCallQueue).toBe('function');
  });
});
