/**
 * describeFailure is what the Telegram-connect paths log instead of an error. Every field an error can
 * carry — name, message, stack, cause, payload, request params and code — holds a synthetic secret
 * here; only fixed labels and a bounded Telegram status may come out.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { TelegramError } from 'gramio';
import { describeBridgeError, describeFailure } from '../../src/utils/safe-failure.ts';

const PASSWORD = 'Synth-2FA pass phrase';
const CODE = 97531;

function secretBearingError(): Error {
  const err = new Error(`failed for ${PASSWORD}`, { cause: PASSWORD });
  err.name = PASSWORD;
  err.stack = `${PASSWORD}\n    at synthetic`;
  return Object.assign(err, { code: CODE, payload: { text: PASSWORD } });
}

describe('describeFailure', () => {
  test('an arbitrary error becomes the fixed label "Error": its name, code and text are dropped', () => {
    const described = describeFailure(secretBearingError());
    expect(described).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(described)).not.toContain(PASSWORD);
    expect(JSON.stringify(described)).not.toContain(String(CODE));
  });

  test('a Telegram API error keeps its class and an HTTP-range status, never its description or params', () => {
    const refused = new TelegramError(
      { ok: false, error_code: 400, description: `Bad Request: ${PASSWORD}` },
      'deleteMessage',
      { chat_id: 1, message_id: 2 },
    );
    expect(describeFailure(refused)).toEqual({ errorName: 'TelegramError', errorCode: 400 });

    const odd = new TelegramError({ ok: false, error_code: CODE, description: PASSWORD }, 'sendMessage', {
      chat_id: 1,
      text: PASSWORD,
    });
    expect(describeFailure(odd)).toEqual({ errorName: 'TelegramError' });
  });

  test('a SQLite error keeps only its class', () => {
    const db = new Database(':memory:');
    let caught: unknown;
    try {
      db.run(`SELECT * FROM "${PASSWORD}"`);
    } catch (err) {
      caught = err;
    }
    db.close();
    expect(describeFailure(caught)).toEqual({ errorName: 'SQLiteError' });
  });

  test('a thrown non-error is described by its kind only', () => {
    expect(describeFailure(PASSWORD)).toEqual({ errorName: 'non-error' });
  });
});

describe('describeBridgeError', () => {
  test('passes only codes the bridge is known to report; anything else, prototype keys included, is "other"', () => {
    expect(describeBridgeError('PHONE_INVALID')).toBe('PHONE_INVALID');
    expect(describeBridgeError('FLOOD_WAIT')).toBe('FLOOD_WAIT');
    expect(describeBridgeError(PASSWORD)).toBe('other');
    expect(describeBridgeError('SYNTH_2FA_PASS')).toBe('other');
    expect(describeBridgeError('toString')).toBe('other');
  });
});
