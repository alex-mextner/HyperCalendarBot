import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '../../utils/logger.ts';

const bridgeLogger = logger.child({ module: 'session-bridge' });

const PYTHON_PATH = 'venv/bin/python';
const CONNECT_SCRIPT = 'scripts/connect-session.py';
const SEND_SCRIPT = 'scripts/send-as-user.py';
const SPAWN_TIMEOUT_MS = 60_000;

// --- zod codecs: JSON string -> parsed schema (no bare JSON.parse) ---

function jsonStringCodec<T extends z.ZodTypeAny>(inner: T) {
  return z.codec(z.string(), inner, {
    decode: (raw, ctx) => {
      try {
        return JSON.parse(raw);
      } catch {
        ctx.issues.push({ code: 'custom', message: 'Invalid JSON from Python bridge', input: raw });
        return {};
      }
    },
    encode: (value) => JSON.stringify(value),
  });
}

// --- Success schemas (one per Python subcommand output shape) ---

const SendCodeSchema = z.object({ phone_code_hash: z.string() });
const SignInSchema = z.object({ status: z.enum(['ok', '2fa_required']) });
const CheckPasswordSchema = z.object({ status: z.literal('ok') });
const SendAsUserSchema = z.object({ status: z.literal('ok') });
const LogOutSchema = z.object({ status: z.literal('ok') });

const AuthorizationSchema = z.object({
  hash: z.number(),
  device_model: z.string(),
  platform: z.string(),
  system_version: z.string(),
  app_name: z.string(),
  country: z.string(),
  region: z.string(),
  ip: z.string(),
  date_active: z.number(),
  current: z.boolean(),
});

const GetAuthorizationsSchema = z.object({ authorizations: z.array(AuthorizationSchema) });

const SuccessSchema = z.union([
  SendCodeSchema,
  SignInSchema,
  CheckPasswordSchema,
  SendAsUserSchema,
  LogOutSchema,
  GetAuthorizationsSchema,
]);

export type BridgeSuccessData = z.infer<typeof SuccessSchema>;
export type Authorization = z.infer<typeof AuthorizationSchema>;

// --- Error schema (message optional: send-as-user.py FLOOD_WAIT omits it) ---

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  retry_after: z.number().optional(),
});

const SuccessStringCodec = jsonStringCodec(SuccessSchema);
const ErrorStringCodec = jsonStringCodec(ErrorSchema);

// --- Result types ---

export interface BridgeSuccess {
  success: true;
  data: BridgeSuccessData;
}

export interface BridgeError {
  success: false;
  error: string;
  message: string;
  retryAfter?: number;
}

export type BridgeResult = BridgeSuccess | BridgeError;

// --- Internal spawn helper ---

async function spawnBridge(args: string[], stdinData?: Buffer): Promise<BridgeResult> {
  const proc = Bun.spawn([PYTHON_PATH, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdinData ?? undefined,
  });

  const timeout = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return parseResult(stdout, stderr, exitCode);
  } finally {
    clearTimeout(timeout);
  }
}

// --- Public functions ---

/**
 * Parse stdout/stderr from a Python bridge process into a typed result.
 * Exit 0 = success JSON, exit 1 = known error JSON, exit >= 2 = unexpected.
 */
function parseResult(stdout: string, stderr: string, exitCode: number): BridgeResult {
  const trimmedStdout = stdout.trim();

  if (exitCode === 0) {
    const parsed = SuccessStringCodec.safeParse(trimmedStdout);
    if (parsed.success) {
      return { success: true, data: parsed.data };
    }
    return { success: false, error: 'UNEXPECTED', message: `Invalid success response: ${trimmedStdout}` };
  }

  if (exitCode === 1) {
    const parsed = ErrorStringCodec.safeParse(trimmedStdout);
    if (parsed.success) {
      return {
        success: false,
        error: parsed.data.error,
        message: parsed.data.message ?? parsed.data.error,
        ...(parsed.data.retry_after !== undefined && { retryAfter: parsed.data.retry_after }),
      };
    }
  }

  // exit >= 2 or unparseable exit-1 output
  return {
    success: false,
    error: 'UNEXPECTED',
    message: stderr.trim() || trimmedStdout || `Process exited with code ${exitCode}`,
  };
}

/** SHA-256 hex of a phone number (for logging without leaking the number). */
function phoneHash(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

/**
 * Create a temp session file with strict permissions (0o600).
 * Uses O_CREAT|O_EXCL|O_WRONLY to prevent symlink-race attacks.
 */
async function createTempSessionFile(userId: number, contents: Buffer): Promise<string> {
  const rand = randomBytes(8).toString('hex');
  const path = `/tmp/tgsess_${userId}_${rand}.session`;
  const fh = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await fh.writeFile(contents);
  } finally {
    await fh.close();
  }
  return path;
}

/** Generate a random temp session path without creating the file. */
function reserveEmptySessionPath(userId: number): string {
  const rand = randomBytes(8).toString('hex');
  return `/tmp/tgsess_${userId}_${rand}.session`;
}

/** Send verification code to a phone number. */
async function sendCode(phone: string, sessionPath: string): Promise<BridgeResult> {
  bridgeLogger.info({ phoneMask: `+***${phone.slice(-4)}` }, 'Sending verification code');
  return spawnBridge([CONNECT_SCRIPT, 'send_code', '--phone', phone, '--session_path', sessionPath]);
}

/** Verify the SMS/Telegram code. */
async function signIn(phone: string, code: string, phoneCodeHash: string, sessionPath: string): Promise<BridgeResult> {
  return spawnBridge([
    CONNECT_SCRIPT,
    'sign_in',
    '--phone',
    phone,
    '--code',
    code,
    '--phone_code_hash',
    phoneCodeHash,
    '--session_path',
    sessionPath,
  ]);
}

/** Submit 2FA password (piped via stdin to avoid ps aux leak). */
async function checkPassword(password: string, sessionPath: string): Promise<BridgeResult> {
  return spawnBridge([CONNECT_SCRIPT, 'check_password', '--session_path', sessionPath], Buffer.from(`${password}\n`));
}

/** Invalidate a Pyrogram session. */
async function logOut(sessionPath: string): Promise<BridgeResult> {
  return spawnBridge([CONNECT_SCRIPT, 'log_out', '--session_path', sessionPath]);
}

/** List active Telegram sessions/authorizations. */
async function getAuthorizations(sessionPath: string): Promise<BridgeResult> {
  return spawnBridge([CONNECT_SCRIPT, 'get_authorizations', '--session_path', sessionPath]);
}

/** Send a message as the connected user. */
async function sendAsUser(sessionPath: string, userId: number, text: string, username?: string): Promise<BridgeResult> {
  const args = [SEND_SCRIPT, '--session_path', sessionPath, '--user_id', userId.toString(), '--text', text];
  if (username) args.push('--username', username);
  return spawnBridge(args);
}

/** Remove a temp session file. Does not throw if already gone. */
async function cleanupTempFile(sessionPath: string): Promise<void> {
  try {
    await unlink(sessionPath);
  } catch (err) {
    // File may have already been cleaned up or never created
    bridgeLogger.debug({ err, sessionPath }, 'Temp session file cleanup: file did not exist');
  }
}

export const SessionBridge = {
  parseResult,
  phoneHash,
  createTempSessionFile,
  reserveEmptySessionPath,
  sendCode,
  signIn,
  checkPassword,
  logOut,
  getAuthorizations,
  sendAsUser,
  cleanupTempFile,
};
