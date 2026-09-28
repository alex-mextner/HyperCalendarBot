// src/bot/scenes/connect-wizard-trace.ts
// A durable per-chat trace of the Telegram-connect wizard, kept beside its scene row: whether the
// wizard is open and at which step, the latest update handled while it was open, and the ids of the
// messages typed into it. The scene row disappears on every exit and after 30 idle minutes; the trace
// outlives it, so the connect-wizard guard still recognises wizard input once the row is gone (GH-639).
// It never holds message text.

import type { Database } from 'bun:sqlite';
import { sqliteStorage } from '@gramio/storage-sqlite';
import { z } from 'zod';
import { chatScopedKey } from './chat-scoped-storage.ts';
import { CONNECT_TELEGRAM_SCENE } from './connect-telegram.scene.ts';

const SCENE_ROW_PREFIX = '@gramio/scenes:';
/** A wizard abandoned at a credential prompt is remembered for this long after its last activity. */
const TRACE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Ids of messages typed into the wizard are kept for Telegram's 48-hour edit window. */
const TYPED_MESSAGE_RETENTION_MS = 48 * 60 * 60 * 1000;

const TraceSchema = z.object({
  /** The chat's scene row holds the wizard, as far as its own writes and deletes tell. */
  open: z.boolean(),
  /** The wizard's step at its last write (1–3 are the phone, code and 2FA prompts). */
  step: z.number(),
  /** Highest update_id handled while the wizard was open, and when (ms). */
  lastOpenUpdateId: z.number().optional(),
  lastOpenAt: z.number().optional(),
  /** Messages typed into the wizard, with when they were seen (ms). */
  typed: z.array(z.object({ messageId: z.number(), at: z.number() })),
  /** The run of the wizard its cancel buttons name (absent for a run started before runs were named). */
  wizardId: z.string().optional(),
  /** The run's temporary login session file, so that a cancel after its scene row expired removes it. */
  sessionPath: z.string().optional(),
});
export type ConnectWizardTrace = z.infer<typeof TraceSchema>;

const ConnectWizardRowSchema = z.object({
  name: z.literal(CONNECT_TELEGRAM_SCENE),
  stepId: z.number(),
  state: z.object({ wizardId: z.string().optional(), sessionPath: z.string().optional() }).optional(),
});

/** What a scene row holding the connect wizard tells: its step, its run and its temp session file. */
export interface ConnectWizardRow {
  step: number;
  wizardId?: string;
  sessionPath?: string;
}

/** The connect wizard in a scene row; undefined for any other value. */
export function connectWizardRow(sceneRow: unknown): ConnectWizardRow | undefined {
  const parsed = ConnectWizardRowSchema.safeParse(sceneRow);
  if (!parsed.success) return undefined;
  const { stepId, state } = parsed.data;
  return { step: stepId, wizardId: state?.wizardId, sessionPath: state?.sessionPath };
}

/** Scene-row key (below chat scoping) of a user's scene in a chat — the key its trace is filed under. */
export function connectWizardRowKey(userId: number, chatId: number): string {
  return chatScopedKey(`${SCENE_ROW_PREFIX}${userId}`, chatId);
}

/**
 * The trace and the scene rows live in bun:sqlite, which answers synchronously. The guard relies on
 * that: each read-modify-write of a trace stays within one turn of the event loop, so concurrently
 * handled updates cannot interleave with it.
 */
export function assertSync<T>(value: T | Promise<T>): T {
  if (value instanceof Promise) throw new Error('the connect-wizard trace needs a synchronous store');
  return value;
}

export interface ConnectWizardTraces {
  read(rowKey: string): ConnectWizardTrace | undefined;
  write(rowKey: string, trace: ConnectWizardTrace): void;
}

/** Traces share the scene store's table under their own key prefix and a longer TTL. */
export function createConnectWizardTraces(db: Database): ConnectWizardTraces {
  const storage = sqliteStorage<{ [key: string]: unknown }>({
    db,
    tableName: 'gramio_scenes',
    $ttl: TRACE_TTL_SECONDS,
  });
  const traceKey = (rowKey: string) => `connect-wizard-trace:${rowKey}`;
  return {
    read(rowKey) {
      const parsed = TraceSchema.safeParse(assertSync(storage.get(traceKey(rowKey))));
      return parsed.success ? parsed.data : undefined;
    },
    write(rowKey, trace) {
      const now = Date.now();
      const typed = trace.typed.filter((entry) => now - entry.at < TYPED_MESSAGE_RETENTION_MS);
      assertSync(storage.set(traceKey(rowKey), { ...trace, typed }));
    },
  };
}

interface SceneRowStorage {
  set(key: string, value: unknown): unknown;
  delete(key: string): unknown;
}

/**
 * Wraps the scene store (below chat scoping) so that every write and delete of a scene row updates its
 * connect-wizard trace: entering or advancing the wizard opens it, any exit or another scene closes it.
 * A row expiring on its TTL goes through neither, which is how the guard tells an abandoned wizard from
 * one that ended.
 */
export function trackConnectWizard<S extends SceneRowStorage>(storage: S, traces: ConnectWizardTraces): S {
  return {
    ...storage,
    set(key: string, value: unknown) {
      const result = storage.set(key, value);
      if (key.startsWith(SCENE_ROW_PREFIX)) {
        const trace = traces.read(key);
        const row = connectWizardRow(value);
        if (row !== undefined) {
          traces.write(key, {
            ...(trace ?? { typed: [] }),
            open: true,
            step: row.step,
            wizardId: row.wizardId,
            sessionPath: row.sessionPath,
          });
        } else if (trace?.open) traces.write(key, { ...trace, open: false });
      }
      return result;
    },
    delete(key: string) {
      const result = storage.delete(key);
      const trace = key.startsWith(SCENE_ROW_PREFIX) ? traces.read(key) : undefined;
      if (trace?.open) traces.write(key, { ...trace, open: false });
      return result;
    },
  };
}
