// Synthetic credentials for redaction tests. Each value is assembled at run time so the source holds
// no literal that looks like a real token to a secret scanner, and none of them is a live credential.

/** Bot id and token body shaped like a Telegram bot token: digits, a colon, 35 URL-safe characters starting with "A". */
export const FAKE_TELEGRAM_BOT_ID = ['4', '2', '4', '2', '4', '2', '4', '2', '4'].join('');
export const FAKE_TELEGRAM_SECRET = `A${'Zq9_-'.repeat(7)}`;
export const FAKE_TELEGRAM_TOKEN = `${FAKE_TELEGRAM_BOT_ID}:${FAKE_TELEGRAM_SECRET}`;

/** An Anthropic API key and an Anthropic OAuth access token, synthetic bodies. */
export const FAKE_ANTHROPIC_API_KEY = ['sk', 'ant', 'api03', 'Zq9Zq9Zq9Zq9Zq9Zq9Zq9_-Zq9'].join('-');
export const FAKE_ANTHROPIC_OAUTH_TOKEN = ['sk', 'ant', 'oat01', 'Ab1Ab1Ab1Ab1Ab1Ab1Ab1_-Ab1'].join('-');

/** An opaque token with no recognisable prefix, like the operator-chosen ADMIN_ALERT_TOKEN. */
export const FAKE_ADMIN_ALERT_TOKEN = 'opaque-admin-alert-value-7f3k9x2m4q';

/** The MTProto API hash: 32 hex characters with no prefix, and a second Claude pool key with no `sk-ant-` prefix. */
export const FAKE_MTPROTO_API_HASH = 'c0ffee15badc0de5c0ffee15badc0de5';
export const FAKE_SECOND_CLAUDE_TOKEN = 'second-pool-key-without-a-prefix-91xk2';

/** The password in `redis://:<password>@host:6379`. */
export const FAKE_REDIS_PASSWORD = 'redis-password-without-shape-5588aa';

/** The URL a failed getMe puts in `err.path`. */
export const FAKE_GETME_URL = `https://api.telegram.org/bot${FAKE_TELEGRAM_TOKEN}/getMe`;

/** The distinctive part of each secret: none of these strings may reach a log line or the alert queue. */
export const SECRET_FRAGMENTS: readonly string[] = [
  FAKE_TELEGRAM_SECRET,
  FAKE_ANTHROPIC_API_KEY,
  FAKE_ANTHROPIC_OAUTH_TOKEN,
  FAKE_ADMIN_ALERT_TOKEN,
];
