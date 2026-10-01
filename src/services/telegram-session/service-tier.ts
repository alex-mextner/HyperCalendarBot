// The shared MTProto service account ("service tier"): the one port for everything the bot does
// with a dedicated service Telegram account — resolve an @username, look a profile up by ID, list a
// group's members, read birthdays, and place voice-call reminders.
//
// It has NO send operation, by design (#753): a service account usually cannot message someone
// first, and Telegram blocks accounts that try. Messages to people go only through the Bot API or
// the sender's own /connect_telegram session (src/services/telegram-session/session-bridge.ts).
//
// Fail-closed: the tier is enabled only when MTPROTO_SERVICE_USER_ID is a positive integer, the
// API id/hash are set, data/voice_caller.session exists, AND check-session.py reports exactly that
// account. Any other state yields a disabled tier and no service script is ever spawned. Consumers
// receive the tier and never re-check env or spawn a service script themselves.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';

export const SERVICE_SESSION_FILE = 'voice_caller.session';
export const SERVICE_PYTHON = 'venv/bin/python';

export type ServiceScript =
  | 'scripts/check-session.py'
  | 'scripts/resolve-username.py'
  | 'scripts/get-user-info.py'
  | 'scripts/get-chat-members.py'
  | 'scripts/fetch-birthdays.py'
  | 'scripts/voice-call-bridge.py';

/** Every Python script the service tier can launch. Nothing outside this module names them
 *  (test/regressions/python-spawn-inventory.test.ts). */
export const SERVICE_SCRIPTS: Readonly<{
  probe: ServiceScript;
  resolveUsername: ServiceScript;
  lookupUser: ServiceScript;
  chatMembers: ServiceScript;
  birthdays: ServiceScript;
  voiceBridge: ServiceScript;
}> = {
  probe: 'scripts/check-session.py',
  resolveUsername: 'scripts/resolve-username.py',
  lookupUser: 'scripts/get-user-info.py',
  chatMembers: 'scripts/get-chat-members.py',
  birthdays: 'scripts/fetch-birthdays.py',
  voiceBridge: 'scripts/voice-call-bridge.py',
};

export interface TelegramProfile {
  id: number;
  firstName?: string;
  username?: string;
  deleted?: boolean;
}

export interface BirthdayDate {
  day: number;
  month: number;
  year?: number;
}

export type ServiceTierDisabledReason =
  | 'service_user_id_unset'
  | 'service_user_id_invalid'
  | 'api_credentials_missing'
  | 'session_missing'
  | 'probe_failed'
  | 'identity_mismatch';

export interface DisabledServiceTier {
  readonly enabled: false;
  readonly reason: ServiceTierDisabledReason;
}

export interface EnabledServiceTier {
  readonly enabled: true;
  /** The Telegram user ID the probe confirmed (equals MTPROTO_SERVICE_USER_ID). */
  readonly accountId: number;
  /** Script CallManager spawns as the long-lived voice-call bridge. */
  readonly voiceBridgeScript: ServiceScript;
  /** An exact @username → profile; null ONLY when Telegram has no such username. Rejects with
   *  ServiceLookupUnavailableError when the lookup could not run (timeout, FloodWait, banned account),
   *  so callers never report "could not check" as "no such person". */
  resolveUsername(username: string): Promise<TelegramProfile | null>;
  /** A positive Telegram user ID → current public profile, or null when unavailable. */
  lookupUser(id: number): Promise<TelegramProfile | null>;
  /** Member IDs the service account can see in the chat, or null when the listing failed. */
  getChatMembers(chatId: number): Promise<number[] | null>;
  /** Per user ID: the visible birthday, or null when checked and there is none to see. IDs the script
   *  could not check are absent, so callers retry them. Null (not a map) when the whole batch failed. */
  fetchBirthdays(ids: readonly number[]): Promise<ReadonlyMap<number, BirthdayDate | null> | null>;
}

export type ServiceTier = DisabledServiceTier | EnabledServiceTier;

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ServiceScriptRunner = (
  script: ServiceScript,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number },
) => Promise<ScriptResult>;

export interface ServiceTierConfig {
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  MTPROTO_SERVICE_USER_ID?: number;
}

export interface ServiceTierDependencies {
  dataDirectory: string;
  run?: ServiceScriptRunner;
  sessionExists?: (path: string) => boolean;
}

const LOOKUP_TIMEOUT_MS = 20_000;
const BIRTHDAY_BATCH_TIMEOUT_MS = 120_000;
const USERNAME = /^[A-Za-z0-9_]{1,64}$/;
/** resolve-username.py exit code for "Telegram has no such username". */
const EXIT_USERNAME_NOT_FOUND = 2;
/** Username resolves are the classic FloodWait trigger, so answers are remembered for a while. */
const RESOLVE_CACHE_TTL_MS = 10 * 60_000;
const RESOLVE_CACHE_MAX = 500;

/** The service account could not answer (as opposed to answering "no such user"). */
export class ServiceLookupUnavailableError extends Error {
  constructor(readonly script: ServiceScript) {
    super(`MTProto service lookup unavailable: ${script}`);
    this.name = 'ServiceLookupUnavailableError';
  }
}

const positiveId = z.number().int().positive().safe();
const ProbeOutput = jsonCodec(z.object({ ok: z.literal(true), user_id: positiveId }));
const ResolvedUser = jsonCodec(
  z.object({ id: positiveId, firstName: z.string().optional(), username: z.string().optional() }),
);
const LookedUpUser = jsonCodec(
  z.object({
    id: positiveId,
    firstName: z.string().optional(),
    username: z.string().optional(),
    deleted: z.boolean().optional(),
  }),
);
const ChatMembers = jsonCodec(z.array(z.object({ id: z.number().int().safe() })));
const Birthdays = jsonCodec(
  z.record(
    z.string(),
    z.object({ day: z.number().int(), month: z.number().int(), year: z.number().int().optional() }).nullable(),
  ),
);

export const spawnServiceScript: ServiceScriptRunner = async (script, args, { stdin, timeoutMs }) => {
  const proc = Bun.spawn([SERVICE_PYTHON, script, ...args], {
    env: { ...process.env },
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

/** Decide once, at startup, whether the service tier is on. Never throws. */
export async function createServiceTier(
  config: ServiceTierConfig,
  dependencies: ServiceTierDependencies,
): Promise<ServiceTier> {
  const expected = config.MTPROTO_SERVICE_USER_ID;
  if (expected === undefined) return disabled('service_user_id_unset');
  if (!positiveId.safeParse(expected).success) return disabled('service_user_id_invalid');
  if (!config.MTPROTO_API_ID || !config.MTPROTO_API_HASH) return disabled('api_credentials_missing');
  const sessionExists = dependencies.sessionExists ?? existsSync;
  if (!sessionExists(join(dependencies.dataDirectory, SERVICE_SESSION_FILE))) return disabled('session_missing');

  const run = dependencies.run ?? spawnServiceScript;
  let probe: ScriptResult;
  try {
    probe = await run(SERVICE_SCRIPTS.probe, [], { timeoutMs: LOOKUP_TIMEOUT_MS });
  } catch {
    return disabled('probe_failed');
  }
  if (probe.exitCode !== 0) return disabled('probe_failed');
  const identity = ProbeOutput.safeParse(probe.stdout.trim());
  if (!identity.success) return disabled('probe_failed');
  if (identity.data.user_id !== expected) return disabled('identity_mismatch');
  return enabledTier(expected, run);
}

function disabled(reason: ServiceTierDisabledReason): DisabledServiceTier {
  return { enabled: false, reason };
}

async function runQuietly(
  run: ServiceScriptRunner,
  script: ServiceScript,
  args: readonly string[],
  options: { stdin?: string; timeoutMs: number },
): Promise<string | null> {
  try {
    const result = await run(script, args, options);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

function enabledTier(accountId: number, run: ServiceScriptRunner): EnabledServiceTier {
  const resolved = new Map<string, { expiresAt: number; profile: TelegramProfile | null }>();
  return {
    enabled: true,
    accountId,
    voiceBridgeScript: SERVICE_SCRIPTS.voiceBridge,
    async resolveUsername(username) {
      const handle = username.trim().replace(/^@/, '');
      if (!USERNAME.test(handle)) return null;
      const key = handle.toLowerCase();
      const cached = resolved.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.profile;
      let result: ScriptResult;
      try {
        result = await run(SERVICE_SCRIPTS.resolveUsername, [handle], { timeoutMs: LOOKUP_TIMEOUT_MS });
      } catch {
        throw new ServiceLookupUnavailableError(SERVICE_SCRIPTS.resolveUsername);
      }
      let profile: TelegramProfile | null = null;
      if (result.exitCode === 0) {
        const parsed = ResolvedUser.safeParse(result.stdout.trim());
        if (!parsed.success) throw new ServiceLookupUnavailableError(SERVICE_SCRIPTS.resolveUsername);
        profile = parsed.data;
      } else if (result.exitCode !== EXIT_USERNAME_NOT_FOUND) {
        throw new ServiceLookupUnavailableError(SERVICE_SCRIPTS.resolveUsername);
      }
      resolved.delete(key);
      if (resolved.size >= RESOLVE_CACHE_MAX) {
        const oldest = resolved.keys().next().value;
        if (oldest !== undefined) resolved.delete(oldest);
      }
      resolved.set(key, { expiresAt: Date.now() + RESOLVE_CACHE_TTL_MS, profile });
      return profile;
    },
    async lookupUser(id) {
      if (!positiveId.safeParse(id).success) return null;
      const stdout = await runQuietly(run, SERVICE_SCRIPTS.lookupUser, [String(id)], { timeoutMs: LOOKUP_TIMEOUT_MS });
      if (stdout === null) return null;
      const parsed = LookedUpUser.safeParse(stdout);
      return parsed.success && parsed.data.id === id ? parsed.data : null;
    },
    async getChatMembers(chatId) {
      if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
      const stdout = await runQuietly(run, SERVICE_SCRIPTS.chatMembers, [String(chatId)], {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      });
      if (stdout === null) return null;
      const parsed = ChatMembers.safeParse(stdout);
      return parsed.success ? parsed.data.map((member) => member.id) : null;
    },
    async fetchBirthdays(ids) {
      const valid = ids.filter((id) => positiveId.safeParse(id).success);
      if (valid.length === 0) return new Map();
      const stdout = await runQuietly(run, SERVICE_SCRIPTS.birthdays, [], {
        stdin: JSON.stringify(valid),
        timeoutMs: BIRTHDAY_BATCH_TIMEOUT_MS,
      });
      if (stdout === null) return null;
      const parsed = Birthdays.safeParse(stdout);
      if (!parsed.success) return null;
      const birthdays = new Map<number, BirthdayDate | null>();
      for (const id of valid) {
        const birthday = parsed.data[String(id)];
        if (birthday !== undefined) birthdays.set(id, birthday);
      }
      return birthdays;
    },
  };
}
