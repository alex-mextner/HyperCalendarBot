import { describe, expect, test } from 'bun:test';
import { SessionBridge } from '../../../src/services/telegram-session/session-bridge.ts';

describe('SessionBridge.parseResult', () => {
  test('success: send_code JSON', () => {
    const result = SessionBridge.parseResult('{"phone_code_hash":"abc123"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ phone_code_hash: 'abc123' });
  });

  test('success: sign_in 2fa_required', () => {
    const result = SessionBridge.parseResult('{"status":"2fa_required"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ status: '2fa_required' });
  });

  test('success: sign_in ok', () => {
    const result = SessionBridge.parseResult('{"status":"ok"}', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ status: 'ok' });
  });

  test('success: get_authorizations', () => {
    const json = JSON.stringify({
      authorizations: [
        {
          hash: 12345,
          device_model: 'iPhone',
          platform: 'iOS',
          system_version: '17.0',
          app_name: 'Telegram',
          country: 'RS',
          region: 'Belgrade',
          ip: '1.2.3.4',
          date_active: 1700000000,
          current: true,
        },
      ],
    });
    const result = SessionBridge.parseResult(json, '', 0);
    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { authorizations: Array<{ hash: number }> };
      expect(data.authorizations).toHaveLength(1);
      const first = data.authorizations[0];
      expect(first?.hash).toBe(12345);
    }
  });

  test('known error: exit 1 + error JSON on stdout', () => {
    const result = SessionBridge.parseResult('{"error":"PHONE_INVALID","message":"Invalid phone number"}', '', 1);
    expect(result).toEqual({
      success: false,
      error: 'PHONE_INVALID',
      message: 'Invalid phone number',
    });
  });

  test('unexpected: exit 2 + stderr traceback (sanitized, raw not exposed)', () => {
    const result = SessionBridge.parseResult('', 'Traceback...', 2);
    expect(result).toEqual({ success: false, error: 'UNEXPECTED', message: 'Bridge process failed (exit 2)' });
  });

  test('flood wait: retry_after surfaced', () => {
    const result = SessionBridge.parseResult(
      '{"error":"FLOOD_WAIT","message":"Rate limited","retry_after":300}',
      '',
      1,
    );
    expect(result).toEqual({
      success: false,
      error: 'FLOOD_WAIT',
      message: 'Rate limited',
      retryAfter: 300,
    });
  });

  test('flood wait without message field (send-as-user.py pattern)', () => {
    const result = SessionBridge.parseResult('{"error":"FLOOD_WAIT","retry_after":120}', '', 1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('FLOOD_WAIT');
      expect(result.retryAfter).toBe(120);
    }
  });

  test('malformed JSON on exit 0 (codec catches parse error, no throw)', () => {
    const result = SessionBridge.parseResult('not-json', '', 0);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('UNEXPECTED');
  });

  test('valid JSON but unknown shape', () => {
    const result = SessionBridge.parseResult('{"random":"field"}', '', 0);
    expect(result.success).toBe(false);
  });

  test('exit 1 with malformed JSON falls through to UNEXPECTED', () => {
    const result = SessionBridge.parseResult('garbage', 'some stderr', 1);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('UNEXPECTED');
  });

  test('exit code > 2 treated as unexpected (sanitized)', () => {
    const result = SessionBridge.parseResult('', 'segfault', 139);
    expect(result).toEqual({ success: false, error: 'UNEXPECTED', message: 'Bridge process failed (exit 139)' });
  });

  test('stdout with trailing newline is trimmed', () => {
    const result = SessionBridge.parseResult('{"phone_code_hash":"abc123"}\n', '', 0);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ phone_code_hash: 'abc123' });
  });
});

describe('SessionBridge.phoneHash', () => {
  test('consistent SHA-256', () => {
    const a = SessionBridge.phoneHash('+79001234567');
    const b = SessionBridge.phoneHash('+79001234567');
    expect(a).toBe(b);
    expect(a.length).toBe(64);
    expect(SessionBridge.phoneHash('+79009999999')).not.toBe(a);
  });

  test('different phones produce different hashes', () => {
    const h1 = SessionBridge.phoneHash('+1234');
    const h2 = SessionBridge.phoneHash('+5678');
    expect(h1).not.toBe(h2);
  });
});

describe('SessionBridge.reserveEmptySessionPath', () => {
  test('returns a path with userId and .session suffix', () => {
    const path = SessionBridge.reserveEmptySessionPath(42);
    expect(path).toStartWith('/tmp/tgsess_42_');
    expect(path).toEndWith('.session');
  });

  test('two calls produce different paths', () => {
    const a = SessionBridge.reserveEmptySessionPath(1);
    const b = SessionBridge.reserveEmptySessionPath(1);
    expect(a).not.toBe(b);
  });
});

describe('SessionBridge.createTempSessionFile', () => {
  test('creates file with correct contents', async () => {
    const contents = Buffer.from('test-session-data');
    const path = await SessionBridge.createTempSessionFile(99, contents);
    try {
      expect(path).toStartWith('/tmp/tgsess_99_');
      expect(path).toEndWith('.session');
      const file = Bun.file(path);
      const data = await file.arrayBuffer();
      expect(Buffer.from(data).toString()).toBe('test-session-data');
    } finally {
      await SessionBridge.cleanupTempFile(path);
    }
  });

  test('file has 0o600 permissions', async () => {
    const path = await SessionBridge.createTempSessionFile(100, Buffer.from('x'));
    try {
      const { stat } = await import('node:fs/promises');
      const s = await stat(path);
      // 0o600 = owner read+write only
      expect(s.mode & 0o777).toBe(0o600);
    } finally {
      await SessionBridge.cleanupTempFile(path);
    }
  });
});

describe('SessionBridge.cleanupTempFile', () => {
  test('removes existing file', async () => {
    const path = await SessionBridge.createTempSessionFile(101, Buffer.from('delete-me'));
    await SessionBridge.cleanupTempFile(path);
    const exists = await Bun.file(path).exists();
    expect(exists).toBe(false);
  });

  test('does not throw on non-existent file', async () => {
    // Should not throw
    await SessionBridge.cleanupTempFile('/tmp/tgsess_nonexistent_abc.session');
  });
});
