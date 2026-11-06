// src/bootstrap/launch.ts
//
// The last startup step: start receiving Telegram updates, by webhook when PUBLIC_DOMAIN is set,
// by long polling otherwise.
//
// Ordering invariants:
//  - It runs LAST, after every queue, handler and shutdown hook exists: updates may arrive the
//    moment the bot starts.
//  - Webhook mode creates a fresh random secret per process and registers the web server's handler
//    on `webServerDeps` BEFORE bot.start() tells Telegram the URL, so the first delivery is served.
//  - Pending updates are kept, not dropped: a message sent while the bot restarted is answered now,
//    and createStaleUpdateGuard skips ones that waited too long.
//  - `bot.start()` is awaited. It is async (getMe, then setWebhook or the polling kick-off); left
//    floating, a getMe reset on 2026-11-05 was an unhandled rejection that killed the process (#972).
//    A transient network failure is retried with bounded backoff; a permanent one (the token is
//    rejected, an unexpected error) fails at once. Both log one clear line and end by throwing, and
//    src/index.ts turns the throw into the crash handlers' alert and exit. Retrying start() is safe:
//    getMe is a read, setWebhook and deleteWebhook are idempotent.

import type { EnvConfig } from '../config/env.ts';
import { publicUrl, TELEGRAM_WEBHOOK_PATH } from '../config/public-url.ts';
import { botLogger } from '../utils/logger.ts';
import type { WebServerDeps } from '../web/server.ts';

export interface WebhookStartOptions {
  webhook: { url: string; secret_token: string };
}

export interface LaunchableBot {
  start(options?: WebhookStartOptions): unknown;
  /** Called when a start finished after shutdown had begun, so polling that just began does not run on. */
  stop?(): unknown;
}

/** How many times start() is tried before the launch gives up and the supervisor restarts the process. */
export const START_MAX_ATTEMPTS = 8;
const START_FIRST_DELAY_MS = 1_000;
const START_MAX_DELAY_MS = 15_000;
/** The longest single pause, reached only by a Telegram flood wait (`retry_after`). */
const START_MAX_FLOOD_WAIT_MS = 120_000;

/** Bun and Node network failure codes that a retry can outlast. */
const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ConnectionClosed',
  'ConnectionRefused',
  'FailedToOpenSocket',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Whether a start() failure is worth another try: a network failure (a string `code` such as
 * ECONNRESET, a timeout or abort, the same wrapped in `cause`), a Telegram answer that is the server's or
 * the rate limit's problem (gramio's TelegramError carries a numeric `code` and the failing `method`;
 * 429 and 5xx), or an answer body that is not JSON (gramio parses every response as JSON, and a gateway
 * error page or an empty body from Telegram's front end fails there as a SyntaxError). A 401/404 token
 * rejection, any other 4xx and an error of unknown kind are not transient.
 */
export function isTransientStartError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, method } = error as Error & { code?: unknown; method?: unknown };
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
  if (typeof code === 'number' && typeof method === 'string') return code === 429 || code >= 500;
  if (error instanceof SyntaxError || error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return error.cause !== undefined && isTransientStartError(error.cause);
}

/** What a log line or error message may show of a failure: stable identifiers, never its message (which can quote a URL). */
function failureKind(error: unknown): { code?: string | number; name?: string } {
  if (!(error instanceof Error)) return {};
  const { code } = error as Error & { code?: unknown };
  return { code: typeof code === 'string' || typeof code === 'number' ? code : undefined, name: error.name };
}

function describeFailure(error: unknown): string {
  const { code, name } = failureKind(error);
  return [name, code].filter((part) => part !== undefined).join(' ') || 'unknown error';
}

/** A start that gave up: the retry loop already logged its fatal line. */
export class TelegramStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TelegramStartError';
  }
}

export interface StartLogger {
  warn(fields: object, message: string): void;
  fatal(fields: object, message: string): void;
  info(fields: object, message: string): void;
}

/** Seams for tests: the pause between attempts and where the lines go. */
export interface StartEnvironment {
  sleep?: (ms: number) => Promise<void>;
  logger?: StartLogger;
}

/**
 * The pause after failed attempt `attempt` (1-based): doubling from one second, capped, and never shorter
 * than the flood wait Telegram asked for (`payload.retry_after` of a 429), itself capped so one answer
 * cannot park the process for hours. A restart straight after giving up would only lengthen a ban.
 */
function startRetryDelayMs(attempt: number, error: unknown): number {
  const backoff = Math.min(START_FIRST_DELAY_MS * 2 ** (attempt - 1), START_MAX_DELAY_MS);
  const { payload } = error as { payload?: { retry_after?: unknown } };
  const retryAfter = payload?.retry_after;
  const floodWaitMs = typeof retryAfter === 'number' && retryAfter > 0 ? retryAfter * 1_000 : 0;
  return Math.max(backoff, Math.min(floodWaitMs, START_MAX_FLOOD_WAIT_MS));
}

async function startWithRetry(
  bot: LaunchableBot,
  start: () => unknown,
  environment: Required<StartEnvironment>,
  shuttingDown: () => boolean,
): Promise<boolean> {
  const { sleep, logger } = environment;
  for (let attempt = 1; ; attempt++) {
    // A shutdown that begins while a start is pending or paused must not leave the bot running: it is
    // closing the queues and the database, and a late start would take updates it can no longer handle
    // and confirm their offset. The shutdown's own bot.stop() ran before polling began, so it is repeated.
    if (shuttingDown()) {
      logger.info({ attempt }, 'Telegram start abandoned: shutdown in progress');
      return false;
    }
    try {
      await start();
      if (!shuttingDown()) return true;
      logger.info({ attempt }, 'Telegram start finished during shutdown; stopping the bot again');
      await stopQuietly(bot, logger);
      return false;
    } catch (error) {
      if (shuttingDown()) {
        logger.info({ attempt, ...failureKind(error) }, 'Telegram start failed during shutdown; not retried');
        return false;
      }
      throwIfStartFailureIsFinal(error, attempt, logger);
      const delayMs = startRetryDelayMs(attempt, error);
      logger.warn(
        { ...failureKind(error), attempt, maxAttempts: START_MAX_ATTEMPTS, delayMs },
        'Telegram start failed on a transient network error; will retry',
      );
      await sleep(delayMs);
    }
  }
}

/**
 * Logs one fatal line and throws when a start failure ends the launch: a permanent one (a rejected token,
 * an error of unknown kind) at once, a transient one on the last attempt. Returns when a retry is due.
 */
function throwIfStartFailureIsFinal(error: unknown, attempt: number, logger: StartLogger): void {
  if (!isTransientStartError(error)) {
    logger.fatal(
      { err: error, attempt },
      'Telegram start failed permanently and is not retried: check BOT_TOKEN and the Telegram API answer',
    );
    throw new TelegramStartError(`Telegram start failed permanently (not retried): ${describeFailure(error)}`, {
      cause: error,
    });
  }
  if (attempt < START_MAX_ATTEMPTS) return;
  logger.fatal(
    { err: error, attempt },
    `Telegram start failed after ${START_MAX_ATTEMPTS} attempts on network errors; giving up so the supervisor restarts the process`,
  );
  throw new TelegramStartError(
    `Telegram start failed after ${START_MAX_ATTEMPTS} attempts: ${describeFailure(error)}`,
    {
      cause: error,
    },
  );
}

async function stopQuietly(bot: LaunchableBot, logger: StartLogger): Promise<void> {
  try {
    await bot.stop?.();
  } catch (err) {
    logger.warn({ err }, 'Stopping the bot after a start that finished during shutdown failed');
  }
}

export interface LaunchCollaborators<TBot extends LaunchableBot> {
  createWebhookHandler: (bot: TBot, secretToken: string) => (req: Request) => Response;
  randomSecret: () => string;
}

/** gramio is imported lazily, as before: long-polling deployments never load the webhook adapter. */
export async function realLaunchCollaborators<TBot extends LaunchableBot>(): Promise<LaunchCollaborators<TBot>> {
  const { Bot, webhookHandler } = await import('gramio');
  return {
    createWebhookHandler: (bot, secretToken) => {
      if (!(bot instanceof Bot)) throw new TypeError('The webhook adapter needs a GramIO Bot');
      return webhookHandler(bot, 'Bun.serve', { secretToken }) as (req: Request) => Response;
    },
    randomSecret: () => crypto.randomUUID(),
  };
}

export async function launchBot<TBot extends LaunchableBot>(
  config: Pick<EnvConfig, 'PUBLIC_DOMAIN'>,
  webServerDeps: Pick<WebServerDeps, 'telegramWebhookHandler' | 'telegramUpdatesClosed'>,
  bot: TBot,
  collaborators?: LaunchCollaborators<TBot>,
  environment: StartEnvironment = {},
): Promise<void> {
  const resolved: Required<StartEnvironment> = {
    sleep: environment.sleep ?? ((ms) => Bun.sleep(ms)),
    logger: environment.logger ?? botLogger,
  };
  if (!config.PUBLIC_DOMAIN) {
    await startWithRetry(
      bot,
      () => bot.start(),
      resolved,
      () => webServerDeps.telegramUpdatesClosed === true,
    );
    return;
  }
  const { createWebhookHandler, randomSecret } = collaborators ?? (await realLaunchCollaborators<TBot>());
  const webhookSecret = randomSecret();
  const webhookUrl = publicUrl(config.PUBLIC_DOMAIN, TELEGRAM_WEBHOOK_PATH);

  webServerDeps.telegramWebhookHandler = createWebhookHandler(bot, webhookSecret);

  const started = await startWithRetry(
    bot,
    () => bot.start({ webhook: { url: webhookUrl, secret_token: webhookSecret } }),
    resolved,
    () => webServerDeps.telegramUpdatesClosed === true,
  );
  if (started) resolved.logger.info({ webhookUrl }, 'Bot started (webhook mode)');
}

export interface LaunchFailureDeps {
  logger: Pick<StartLogger, 'fatal' | 'warn'>;
  /** Queues the crash alert; may throw (a locked database). */
  alertFatal(error: Error): void;
  /** The graceful shutdown, with its own deadline. */
  shutdown(): Promise<void>;
  exit(code: number): void;
}

/**
 * The exit after a launch that threw. By then the workers started before the launch may hold jobs (the
 * retries last a minute and more), so the process shuts down gracefully before exiting 1 and the
 * supervisor restarts it. The alert goes first because shutdown closes the database that holds the alert
 * queue; a failing alert or shutdown never skips the exit. The retry loop logged its own fatal line; an
 * error from anywhere else in the launch (the webhook adapter) is logged here, or it would leave no trace.
 */
export async function handleLaunchFailure(error: unknown, deps: LaunchFailureDeps): Promise<void> {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (!(failure instanceof TelegramStartError)) deps.logger.fatal({ err: failure }, 'Bot launch failed');
  try {
    deps.alertFatal(failure);
  } catch (err) {
    deps.logger.warn({ err }, 'The launch-failure alert could not be queued');
  }
  try {
    await deps.shutdown();
  } catch (err) {
    deps.logger.warn({ err }, 'Shutdown after a failed launch threw');
  }
  deps.exit(1);
}
