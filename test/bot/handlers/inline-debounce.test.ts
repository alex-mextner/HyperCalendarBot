import { describe, expect, test } from 'bun:test';
import { InlineDebouncer } from '../../../src/bot/handlers/inline.handler';

describe('InlineDebouncer', () => {
  test('first call for user is not debounced', () => {
    const debouncer = new InlineDebouncer(300);
    expect(debouncer.shouldProcess(100)).toBe(true);
  });

  test('rapid second call within window is debounced', () => {
    const debouncer = new InlineDebouncer(300);
    debouncer.shouldProcess(100);
    expect(debouncer.shouldProcess(100)).toBe(false);
  });

  test('call after window passes is not debounced', async () => {
    const debouncer = new InlineDebouncer(50); // 50ms for fast test
    debouncer.shouldProcess(100);
    await new Promise((r) => setTimeout(r, 60));
    expect(debouncer.shouldProcess(100)).toBe(true);
  });

  test('different users are independent', () => {
    const debouncer = new InlineDebouncer(300);
    expect(debouncer.shouldProcess(100)).toBe(true);
    expect(debouncer.shouldProcess(200)).toBe(true);
  });
});
