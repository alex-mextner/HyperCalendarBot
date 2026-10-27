// src/bootstrap/core.ts
//
// The first startup phase: configuration, the database and the process-wide AI configuration that
// has to exist before any service is built.
//
// Ordering invariants (each step depends on the previous one):
//  1. loadConfig() throws on a missing/invalid required variable. The crash handlers are already
//     installed, so that is the process's failure path (log fatal, exit 1); nothing is open yet.
//  2. createDatabase() opens SQLite and runs migrations.
//  3. The crash alert sink is armed only after the database exists (it writes to db.alerts), and
//     only when ADMIN_ALERT_TOKEN is set.
//  4. The master-key check runs BEFORE anything can start serving: a key that cannot decrypt the
//     stored Telegram sessions must stop the process (exit 1), never silently orphan them.
//  5. Provider alerts, the durable provider circuit and AI usage recording are configured last;
//     everything that makes AI calls is created after this returns.

import type { EnvConfig } from '../config/env.ts';
import { loadConfig } from '../config/env.ts';
import { createDatabase, type DatabaseService } from '../database/index.ts';
import type { TelegramSessionRepository } from '../database/repositories/telegram-session.repository.ts';
import { configureProviderCircuit } from '../services/ai/provider-circuit.ts';
import { configureAiUsageRecording } from '../services/ai/usage-recorder.ts';
import type { VerifyMasterKeyResult } from '../services/crypto/master-key-check.ts';
import { initProviderAlerts } from '../utils/ai-provider-alert.ts';
import { botLogger } from '../utils/logger.ts';
import type { CrashHandlers } from './crash-handlers.ts';

export interface MasterKeyCheckDeps {
  logger: { fatal(obj: object, message: string): void };
  exit: (code: number) => void;
  verify: (sessions: TelegramSessionRepository, key: Buffer) => VerifyMasterKeyResult;
}

async function realMasterKeyCheckDeps(): Promise<MasterKeyCheckDeps> {
  const { verifyMasterKey } = await import('../services/crypto/master-key-check.ts');
  return { logger: botLogger, exit: (code) => process.exit(code), verify: verifyMasterKey };
}

/**
 * Verifies the master key against the most recent stored session before the bot starts.
 * Returns true when startup may continue; on a mismatch it logs fatal and asks to exit(1).
 */
export async function verifyMasterKeyOrExit(
  masterKeyHex: string | undefined,
  sessions: TelegramSessionRepository,
  deps?: MasterKeyCheckDeps,
): Promise<boolean> {
  if (!masterKeyHex) return true;
  const { logger, exit, verify } = deps ?? (await realMasterKeyCheckDeps());
  const result = verify(sessions, Buffer.from(masterKeyHex, 'hex'));
  if (result.ok) return true;
  logger.fatal({ err: result.err }, 'TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start');
  exit(1);
  return false;
}

export interface CoreServices {
  config: EnvConfig;
  db: DatabaseService;
}

export async function initCore(crashHandlers: CrashHandlers): Promise<CoreServices> {
  const config = loadConfig();
  const db = createDatabase(config.DATABASE_PATH);

  if (config.ADMIN_ALERT_TOKEN) {
    crashHandlers.setAlertSink((msg) => db.alerts.push(msg, 'bot-crash'));
  }

  // Verify master key matches existing sessions before starting the bot
  await verifyMasterKeyOrExit(config.TELEGRAM_SESSION_MASTER_KEY, db.telegramSessions);

  // Unconditional: /ready reads the outage record this keeps, and whether an admin
  // chat is configured has nothing to do with whether the bot can answer people.
  // Without an admin the alerts are logged instead of sent.
  initProviderAlerts({ botToken: config.BOT_TOKEN, adminId: config.BOT_ADMIN_ID });

  // Durable per-account provider circuits live in a sidecar next to the calendar
  // database, so a deploy does not forget which accounts are out.
  configureProviderCircuit(`${config.DATABASE_PATH}.provider-state.sqlite`);

  // Every provider attempt of an AI round is recorded in the calendar database for per-provider statistics.
  configureAiUsageRecording(db.aiUsage);

  return { config, db };
}
