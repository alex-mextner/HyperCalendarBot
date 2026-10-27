import { describe, expect, test } from 'bun:test';
import { isMessageNotModified } from '../../src/bootstrap/location.ts';

describe('isMessageNotModified', () => {
  test('recognises the Telegram "message is not modified" failure', () => {
    expect(isMessageNotModified(new Error('Bad Request: message is not modified: specified new content'))).toBe(true);
  });

  test('does not hide other edit failures', () => {
    expect(isMessageNotModified(new Error('Bad Request: message to edit not found'))).toBe(false);
  });
});
