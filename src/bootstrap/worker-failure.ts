// src/bootstrap/worker-failure.ts
//
// One BullMQ 'failed' handler per worker: logs through pino, Telegrams the admin and pushes to the
// alert queue. Without BOT_ADMIN_ID (dev/test) it still logs and skips Telegram + the alert queue;
// without ADMIN_ALERT_TOKEN it skips only the alert queue.

import type { EnvConfig } from '../config/env.ts';
import { botLogger } from '../utils/logger.ts';
import { makeWorkerFailureHandler } from '../utils/worker-alert.ts';

export type WorkerFailedHandler = (job: { id?: string } | undefined, err: Error) => void;
export type WorkerFailedFactory = (workerName: string) => WorkerFailedHandler;

export interface WorkerFailureSettings {
  config: Pick<EnvConfig, 'BOT_TOKEN' | 'BOT_ADMIN_ID' | 'ADMIN_ALERT_TOKEN'>;
  pushAlert: (message: string, source: string) => void;
}

export interface WorkerFailureCollaborators {
  logger: { warn(obj: object, message: string): void; error(obj: object, message: string): void };
  makeAlertHandler: typeof makeWorkerFailureHandler;
}

const realCollaborators: WorkerFailureCollaborators = {
  logger: botLogger,
  makeAlertHandler: makeWorkerFailureHandler,
};

export function createWorkerFailedFactory(
  settings: WorkerFailureSettings,
  collaborators: WorkerFailureCollaborators = realCollaborators,
): WorkerFailedFactory {
  const { config } = settings;
  return (name) => {
    const alertHandler = config.BOT_ADMIN_ID
      ? collaborators.makeAlertHandler(name, {
          botToken: config.BOT_TOKEN,
          adminId: config.BOT_ADMIN_ID,
          pushAlert: config.ADMIN_ALERT_TOKEN ? settings.pushAlert : undefined,
        })
      : null;
    return (job, err) => {
      // UnrecoverableError = intentional permanent failure (e.g. Telegram 403).
      // Already logged at warn by the throwing site — don't spam error logs.
      if (err.name === 'UnrecoverableError') {
        collaborators.logger.warn({ jobId: job?.id, worker: name, err }, 'Worker job permanently failed (no retry)');
      } else {
        collaborators.logger.error({ jobId: job?.id, worker: name, err }, 'Worker job failed');
      }
      alertHandler?.(job, err);
    };
  };
}
