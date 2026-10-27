// src/config/env.ts

import { MODEL_ROLES } from '../services/ai/model-presets.ts';
import { PROVIDER_IDS, type ProviderId } from '../services/ai/provider-ids.ts';
import {
  AI_ROUTING_MODES,
  type AiRoutingMode,
  parseRoleChain,
  ROLE_CHAIN_VARIABLES,
  type RoleChains,
} from '../services/ai/role-routing.ts';
import { TOOL_SCHEMA_MODES, type ToolSchemaMode } from '../services/ai/tool-schema-mode.ts';
import { logger, logOnce } from '../utils/logger.ts';
import { GOOGLE_OAUTH_CALLBACK_PATH, publicUrl } from './public-url.ts';

/** Owner-chosen order for main requests: z.ai, then Claude, then Hugging Face.
 * Explicit operator order (AI_SMART_CHAIN) wins; token-fit guards, circuits and fallback stay intact.
 * A provider without its key or the chain's model is skipped, so a depleted z.ai falls through to Claude.
 */
export const DEFAULT_SMART_CHAIN: ProviderId[] = ['zai', 'claude', 'hf'];
/** Short requests use the same owner-chosen order, with each provider's fast model.
 * Explicit operator order (AI_FAST_CHAIN) still wins.
 */
export const DEFAULT_FAST_CHAIN: ProviderId[] = ['zai', 'claude', 'hf'];

export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * A chain order together with where it came from. The source is carried rather
 * than inferred, because the two cases warrant different noise: a provider the
 * operator named and did not configure deserves a warning, while one that is
 * merely absent from the default order is the documented minimal deployment.
 */
export interface ChainOrder {
  readonly order: ProviderId[];
  readonly fromEnv: boolean;
  /**
   * Where to fall back when nothing in `order` turns out to be configured. It
   * travels with the order so the pairing cannot be got wrong: passing the fast
   * chain with the smart chain's default would type-check otherwise.
   */
  readonly fallback: ProviderId[];
}

function parseChain(name: string, fallback: ProviderId[]): ChainOrder {
  const raw = process.env[name];
  if (!raw) return { order: fallback, fromEnv: false, fallback };
  const parsed: ProviderId[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id) continue;
    const known = PROVIDER_IDS.find((candidate): candidate is ProviderId => candidate === id);
    if (!known) {
      logOnce(`${name}:unknown:${id}`, () =>
        logger.warn({ name, id, known: PROVIDER_IDS }, 'Unknown provider in chain order — ignoring it'),
      );
      continue;
    }
    if (!parsed.includes(known)) parsed.push(known);
  }
  if (parsed.length === 0) {
    logOnce(`${name}:empty:${raw}`, () =>
      logger.warn({ name, raw, fallback }, 'Chain order named no known provider — using the default order'),
    );
    return { order: fallback, fromEnv: false, fallback };
  }
  return { order: parsed, fromEnv: true, fallback };
}

export interface EnvConfig {
  BOT_TOKEN: string;
  DATABASE_PATH: string;
  NODE_ENV: 'development' | 'production';

  // AI primary provider (z.ai coding endpoint)
  ZAI_API_KEY: string;
  ZAI_BASE_URL: string;
  ZAI_MODEL: string;
  ZAI_FAST_MODEL: string;

  // HuggingFace Router (fallback, tool calling capable)
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;

  REDIS_URL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  OAUTH_SERVER_PORT?: number;
  ENCRYPTION_KEY?: string;
  PUBLIC_DOMAIN?: string;
  BOT_USERNAME?: string;
  MTPROTO_API_ID?: number;
  MTPROTO_API_HASH?: string;
  MTPROTO_SERVICE_USER_ID?: number;
  // Whisper voice transcription only; Groq is not an AI chat provider any more
  GROQ_API_KEY?: string;
  // Anthropic Claude (paid reserve after z.ai; OpenAI-compatible endpoint)
  CLAUDE_API_TOKEN?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_FAST_MODEL?: string;
  // OpenRouter (optional; serves DeepSeek and GLM Flash behind one key). Used only when
  // a chain names it and both the key and that chain's model are set.
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_FAST_MODEL?: string;

  /** `hybrid` (default), `lazy` or `full`: how many tool schemas a text request carries. Set `full` for an instant rollback. */
  AI_TOOL_SCHEMA_MODE?: ToolSchemaMode;
  /**
   * The order providers are tried in, first to last, for the chain that answers
   * users (SMART) and the one behind summarizing and validation (FAST). A
   * provider whose model or key is missing is skipped, so a name here is a
   * preference, not a requirement.
   */
  AI_SMART_CHAIN: ChainOrder;
  AI_FAST_CHAIN: ChainOrder;
  /** `legacy` (default): the smart/fast chains above. `roles`: planner/executor/repair chains, see role-routing.ts. */
  AI_ROUTING: AiRoutingMode;
  /** Canary for `roles`: only these users. Absent: everyone, once AI_ROUTING is `roles`. */
  AI_ROUTING_USER_IDS?: number[];
  AI_ROLE_CHAINS: RoleChains;
  BOT_ADMIN_ID?: number;
  INTENT_LEARNER_DAILY_LIMIT: number;
  INLINE_BOT_TOKEN?: string;
  INLINE_BOT_USERNAME?: string;
  SILERO_PYTHON_PATH?: string;
  DEEPGRAM_API_KEY?: string;
  DISABLE_VOICE?: boolean;
  AI_DEBUG_LOGS?: boolean;
  ADMIN_ALERT_TOKEN?: string;
  OPENWEATHER_API_KEY?: string;
  GOOGLE_API_KEY?: string;
  TELEGRAM_SESSION_MASTER_KEY?: string;
}

/** A bounded list of positive safe-integer user ids (a canary), or undefined when the variable is unset. */
function parseUserIdList(name: string): number[] | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const parts = raw.split(',');
  if (
    raw.length > 1800 ||
    parts.length > 100 ||
    parts.some((p) => !/^[1-9][0-9]*$/.test(p.trim()) || !Number.isSafeInteger(Number(p)))
  )
    throw new Error(`${name} must be at most 100 positive safe integer IDs`);
  return [...new Set(parts.map(Number))];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

/** An optional string variable: unset and empty both mean "not configured". */
function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}

/** An optional numeric variable converted with `Number`; unset and empty mean "not configured". */
function optionalNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  return raw ? Number(raw) : undefined;
}

/** An optional integer variable; a non-numeric value is a configuration error. */
function parseIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a valid number`);
  return parsed;
}

function parseToolSchemaMode(): ToolSchemaMode {
  const requested = process.env.AI_TOOL_SCHEMA_MODE ?? 'hybrid';
  const mode = TOOL_SCHEMA_MODES.find((candidate) => candidate === requested);
  if (!mode) throw new Error(`AI_TOOL_SCHEMA_MODE must be one of ${TOOL_SCHEMA_MODES.join(', ')}`);
  return mode;
}

function parseAiRouting(): AiRoutingMode {
  const requested = process.env.AI_ROUTING ?? 'legacy';
  const mode = AI_ROUTING_MODES.find((candidate) => candidate === requested);
  if (!mode) throw new Error('AI_ROUTING must be legacy or roles');
  return mode;
}

function parseRoleChains(): RoleChains {
  const chains: RoleChains = { planner: [], executor: [], repair: [] };
  for (const role of MODEL_ROLES) {
    const variable = ROLE_CHAIN_VARIABLES[role];
    chains[role] = parseRoleChain(process.env[variable], (entry) =>
      logOnce(`${variable}:unknown:${entry}`, () =>
        logger.warn({ variable, entry }, 'Unknown provider or malformed entry in role chain — ignoring it'),
      ),
    );
  }
  return chains;
}

function parsePublicDomain(): string | undefined {
  const domain = optionalEnv('PUBLIC_DOMAIN');
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i.test(domain)) {
    // A scheme or path would register https://https://… with Telegram and Google.
    throw new Error('PUBLIC_DOMAIN must be a bare host such as hypercal.mextner.com, without scheme or path');
  }
  return domain;
}

/** Google OAuth stores refresh tokens encrypted, so a client id without a valid key is unusable. */
function assertGoogleEncryptionKey(googleClientId: string | undefined, encryptionKey: string | undefined): void {
  if (!googleClientId) return;
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required when GOOGLE_CLIENT_ID is set');
  }
  if (!/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256-GCM)');
  }
}

/** An invalid key disables the connect-telegram feature instead of failing startup. */
function parseTelegramSessionMasterKey(): string | undefined {
  const raw = process.env.TELEGRAM_SESSION_MASTER_KEY?.trim();
  if (!raw) return undefined;
  if (/^[0-9a-f]{64}$/i.test(raw)) return raw;
  logger.warn('TELEGRAM_SESSION_MASTER_KEY must be 64 hex chars (32 bytes) — connect-telegram feature disabled');
  return undefined;
}

export function loadConfig(): EnvConfig {
  const BOT_TOKEN = requireEnv('BOT_TOKEN');
  const toolSchemaMode = parseToolSchemaMode();
  const aiRouting = parseAiRouting();
  const aiRoutingUserIds = parseUserIdList('AI_ROUTING_USER_IDS');
  const aiRoleChains = parseRoleChains();

  const GOOGLE_CLIENT_ID = optionalEnv('GOOGLE_CLIENT_ID');
  const REDIS_URL = requireEnv('REDIS_URL');
  const ENCRYPTION_KEY = optionalEnv('ENCRYPTION_KEY');
  const PUBLIC_DOMAIN = parsePublicDomain();
  assertGoogleEncryptionKey(GOOGLE_CLIENT_ID, ENCRYPTION_KEY);

  const GOOGLE_REDIRECT_URI =
    process.env.GOOGLE_REDIRECT_URI ||
    (PUBLIC_DOMAIN ? publicUrl(PUBLIC_DOMAIN, GOOGLE_OAUTH_CALLBACK_PATH) : undefined);

  const BOT_ADMIN_ID = parseIntegerEnv('BOT_ADMIN_ID');
  const INTENT_LEARNER_DAILY_LIMIT = parseIntegerEnv('INTENT_LEARNER_DAILY_LIMIT') ?? 100;
  const telegramSessionMasterKey = parseTelegramSessionMasterKey();

  return {
    BOT_TOKEN,
    DATABASE_PATH: process.env.DATABASE_PATH || './data/calendar.db',
    NODE_ENV: (process.env.NODE_ENV as EnvConfig['NODE_ENV']) || 'development',

    // AI primary (z.ai)
    ZAI_API_KEY: requireEnv('ZAI_API_KEY'),
    ZAI_BASE_URL: requireEnv('ZAI_BASE_URL'),
    ZAI_MODEL: requireEnv('ZAI_MODEL'),
    ZAI_FAST_MODEL: requireEnv('ZAI_FAST_MODEL'),

    // HuggingFace
    HF_TOKEN: requireEnv('HF_TOKEN'),
    HF_BASE_URL: requireEnv('HF_BASE_URL'),
    HF_MODEL: requireEnv('HF_MODEL'),
    HF_FAST_MODEL: requireEnv('HF_FAST_MODEL'),

    REDIS_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: optionalEnv('GOOGLE_CLIENT_SECRET'),
    GOOGLE_REDIRECT_URI,
    OAUTH_SERVER_PORT: optionalNumberEnv('OAUTH_SERVER_PORT'),
    ENCRYPTION_KEY,
    PUBLIC_DOMAIN,
    BOT_USERNAME: optionalEnv('BOT_USERNAME'),
    MTPROTO_API_ID: optionalNumberEnv('MTPROTO_API_ID'),
    MTPROTO_API_HASH: optionalEnv('MTPROTO_API_HASH'),
    MTPROTO_SERVICE_USER_ID: optionalNumberEnv('MTPROTO_SERVICE_USER_ID'),
    GROQ_API_KEY: optionalEnv('GROQ_API_KEY'),
    CLAUDE_API_TOKEN: optionalEnv('CLAUDE_API_TOKEN'),
    CLAUDE_MODEL: optionalEnv('CLAUDE_MODEL'),
    CLAUDE_FAST_MODEL: optionalEnv('CLAUDE_FAST_MODEL'),
    OPENROUTER_API_KEY: optionalEnv('OPENROUTER_API_KEY'),
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
    OPENROUTER_MODEL: optionalEnv('OPENROUTER_MODEL'),
    OPENROUTER_FAST_MODEL: optionalEnv('OPENROUTER_FAST_MODEL'),
    AI_TOOL_SCHEMA_MODE: toolSchemaMode,
    AI_SMART_CHAIN: parseChain('AI_SMART_CHAIN', DEFAULT_SMART_CHAIN),
    AI_FAST_CHAIN: parseChain('AI_FAST_CHAIN', DEFAULT_FAST_CHAIN),
    AI_ROUTING: aiRouting,
    AI_ROUTING_USER_IDS: aiRoutingUserIds,
    AI_ROLE_CHAINS: aiRoleChains,
    BOT_ADMIN_ID,
    INTENT_LEARNER_DAILY_LIMIT,
    INLINE_BOT_TOKEN: optionalEnv('INLINE_BOT_TOKEN'),
    INLINE_BOT_USERNAME: optionalEnv('INLINE_BOT_USERNAME'),
    SILERO_PYTHON_PATH: optionalEnv('SILERO_PYTHON_PATH'),
    DEEPGRAM_API_KEY: optionalEnv('DEEPGRAM_API_KEY'),
    DISABLE_VOICE: process.env.DISABLE_VOICE === 'true' || undefined,
    AI_DEBUG_LOGS: process.env.AI_DEBUG_LOGS === 'true' || undefined,
    ADMIN_ALERT_TOKEN: optionalEnv('ADMIN_ALERT_TOKEN'),
    OPENWEATHER_API_KEY: optionalEnv('OPENWEATHER_API_KEY'),
    GOOGLE_API_KEY: optionalEnv('GOOGLE_API_KEY'),
    TELEGRAM_SESSION_MASTER_KEY: telegramSessionMasterKey,
  };
}
