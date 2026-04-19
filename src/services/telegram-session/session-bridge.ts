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

  if (stderr.trim()) {
    bridgeLogger.debug({ stderr: stderr.trim(), exitCode }, 'Bridge stderr');
  }

  if (exitCode === 0) {
    const parsed = SuccessStringCodec.safeParse(trimmedStdout);
    if (parsed.success) {
      return { success: true, data: parsed.data };
    }
    bridgeLogger.debug({ stdout: trimmedStdout }, 'Unexpected success output from Python bridge');
    return { success: false, error: 'UNEXPECTED', message: 'Bridge returned unparseable success output' };
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

  // exit >= 2 or unparseable exit-1 output — log raw output, return sanitized message
  bridgeLogger.debug({ stdout: trimmedStdout, stderr: stderr.trim(), exitCode }, 'Unexpected bridge error');
  return {
    success: false,
    error: 'UNEXPECTED',
    message: `Bridge process failed (exit ${exitCode})`,
  };
}

/** SHA-256 hex of a phone number (for logging without leaking the number). */
function phoneHash(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

/**
 * Create a temp session file with strict permissions (0o600).
 * O_CREAT|O_EXCL: fail if path exists (collision/preemptive attack).
 * O_NOFOLLOW: refuse to follow symlinks (symlink-race protection).
 * O_WRONLY: write-only (no read-back through this fd).
 */
async function createTempSessionFile(userId: number, contents: Buffer): Promise<string> {
  const rand = randomBytes(8).toString('hex');
  const path = `/tmp/tgsess_${userId}_${rand}.session`;
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  const fh = await open(path, flags, 0o600);
  try {
    await fh.writeFile(contents);
  } finally {
    await fh.close();
  }
  return path;
}

/**
 * Generate a random temp session path without creating the file.
 * 16 random bytes (128-bit) make brute-force path prediction infeasible.
 * The file is created by the Python Pyrogram process; we only generate the path.
 */
function reserveEmptySessionPath(userId: number): string {
  const rand = randomBytes(16).toString('hex');
  return `/tmp/tgsess_${userId}_${rand}.session`;
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

/**
 * Long-lived auth handle: one Python process does send_code + sign_in
 * within the same MTProto session (avoids CODE_EXPIRED from reconnection).
 */
interface AuthHandle {
  /** Phone code hash from send_code */
  phoneCodeHash: string;
  /** Send OTP code to the process and get sign_in result */
  submitCode(code: string): Promise<BridgeResult>;
  /** Kill the process if user cancels */
  kill(): void;
}

/** In-memory map: userId → live auth process handle */
const liveAuthHandles = new Map<number, AuthHandle>();

function getLiveAuthHandle(userId: number): AuthHandle | undefined {
  return liveAuthHandles.get(userId);
}

function removeLiveAuthHandle(userId: number): void {
  const handle = liveAuthHandles.get(userId);
  if (handle) {
    handle.kill();
    liveAuthHandles.delete(userId);
  }
}

/**
 * Spawn a single Python process that sends the code and waits for the OTP on stdin.
 * Returns an AuthHandle; call handle.submitCode(code) when the user enters the code.
 */
async function spawnSendAndSign(
  phone: string,
  sessionPath: string,
  userId: number,
): Promise<BridgeResult & { handle?: AuthHandle }> {
  bridgeLogger.info({ phoneMask: `+***${phone.slice(-4)}` }, 'Spawning send_and_sign process');

  // Kill any previous handle for this user
  removeLiveAuthHandle(userId);

  const proc = Bun.spawn(
    [PYTHON_PATH, CONNECT_SCRIPT, 'send_and_sign', '--phone', phone, '--session_path', sessionPath],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    },
  );

  const timeout = setTimeout(
    () => {
      proc.kill();
      liveAuthHandles.delete(userId);
    },
    5 * 60 * 1000,
  ); // 5 min timeout for entire flow

  // Read the first line from stdout (phone_code_hash JSON)
  const reader = proc.stdout.getReader();
  let firstLine = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      firstLine += new TextDecoder().decode(value);
      if (firstLine.includes('\n')) break;
    }
  } catch {
    clearTimeout(timeout);
    proc.kill();
    return { success: false, error: 'UNEXPECTED', message: 'Failed to read send_code output' };
  }

  const line = firstLine.split('\n')[0]!.trim();
  const parsed = SuccessStringCodec.safeParse(line);
  if (!parsed.success) {
    clearTimeout(timeout);
    // Maybe it's an error JSON
    const errParsed = ErrorStringCodec.safeParse(line);
    if (errParsed.success) {
      return { success: false, error: errParsed.data.error, message: errParsed.data.message ?? errParsed.data.error };
    }
    proc.kill();
    return { success: false, error: 'UNEXPECTED', message: 'Unparseable send_code output' };
  }

  const phoneCodeHash = (parsed.data as { phone_code_hash?: string }).phone_code_hash;
  if (!phoneCodeHash) {
    clearTimeout(timeout);
    proc.kill();
    return { success: false, error: 'UNEXPECTED', message: 'No phone_code_hash in output' };
  }

  const handle: AuthHandle = {
    phoneCodeHash,
    async submitCode(code: string): Promise<BridgeResult> {
      try {
        // Write the code to stdin
        proc.stdin.write(`${code}\n`);
        await proc.stdin.flush();
        proc.stdin.end();

        // Read remaining stdout + stderr
        const [restStdout, stderr, exitCode] = await Promise.all([
          // Read remaining output from the reader
          (async () => {
            let rest = firstLine.includes('\n') ? firstLine.split('\n').slice(1).join('\n') : '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              rest += new TextDecoder().decode(value);
            }
            return rest.trim();
          })(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);

        if (stderr.trim()) {
          bridgeLogger.debug({ stderr: stderr.trim(), exitCode }, 'Bridge stderr (send_and_sign)');
        }

        return parseResult(restStdout, stderr, exitCode);
      } finally {
        clearTimeout(timeout);
        liveAuthHandles.delete(userId);
      }
    },
    kill() {
      clearTimeout(timeout);
      proc.kill();
    },
  };

  liveAuthHandles.set(userId, handle);
  return { success: true, data: { phone_code_hash: phoneCodeHash }, handle };
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
  spawnSendAndSign,
  getLiveAuthHandle,
  removeLiveAuthHandle,
  checkPassword,
  logOut,
  getAuthorizations,
  sendAsUser,
  cleanupTempFile,
};
