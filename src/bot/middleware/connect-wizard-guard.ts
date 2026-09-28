// src/bot/middleware/connect-wizard-guard.ts
// Recognises text typed into the Telegram-connect wizard — a phone number, login code or 2FA
// password — before anything else handles the update (the rate limiter included) and takes it off
// the chat. It also recognises such text where the wizard's scene row can no longer show it: text sent
// before a concurrent cancel but handled after it, and the answer to a credential prompt whose idle
// wizard expired. Those are deleted and go no further (GH-519, GH-639).

import type { Next, TelegramUpdate } from 'gramio';
import { t, toLang } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { runWithChatId } from '../scenes/chat-scoped-storage.ts';
import {
  assertSync,
  type ConnectWizardTraces,
  connectWizardRowKey,
  connectWizardStep,
} from '../scenes/connect-wizard-trace.ts';

const guardLogger = logger.child({ module: 'connect-wizard-guard' });

/** The consent screen (0) and the phone, code and 2FA prompts (1–3) read typed text; 1–3 ask for a credential. */
const FIRST_CREDENTIAL_STEP = 1;
const LAST_TYPING_STEP = 3;
/**
 * Update ids grow with every update the bot receives, so a text whose id is not above the latest update
 * handled while the wizard was open was sent while it was open. Concurrent deliveries are seconds apart,
 * and Telegram may restart the numbering after a week without updates, so this holds only briefly.
 */
const LATE_DELIVERY_WINDOW_MS = 5 * 60 * 1000;

type ReplyFn = (text: string, opts?: { [key: string]: unknown }) => Promise<unknown>;

/** The part of a GramIO context the guard reads; `send` and `delete` exist on message contexts. */
interface GuardContext {
  update?: TelegramUpdate;
  dbUser?: User;
  send?: ReplyFn;
  delete?: () => Promise<unknown>;
}

/**
 * `typed`: text typed into the open wizard — only its scene may handle it; chat logging stores the marker.
 * `redact`: an edit of wizard input, or text whose wizard state could not be read — chat logging stores
 * the marker, and the update is otherwise handled as usual.
 */
type WizardInputMark = 'typed' | 'redact';

type Verdict =
  | { kind: 'none' }
  | { kind: 'typed'; removeFromChat: boolean }
  | { kind: 'redact' }
  /** Sent while the wizard was open, handled after it closed. */
  | { kind: 'late' }
  /** The answer to a credential prompt whose idle wizard expired. */
  | { kind: 'expired' };

const NONE: Verdict = { kind: 'none' };

export interface ConnectWizardGuardDeps {
  /** Chat-scoped scene storage (`@gramio/scenes:<userId>` keys). */
  sceneStorage: { get(key: string): unknown };
  traces: ConnectWizardTraces;
}

export interface ConnectWizardGuard {
  /** Registered before the rate limiter, so that input it drops is still taken off the chat. */
  middleware(context: GuardContext, next: Next): Promise<unknown>;
  /** Whether chat logging must store this update's text or edit only as the redaction marker. */
  isConnectWizardInput(context: { update?: TelegramUpdate }): boolean;
  /**
   * Registered right after the scenes plugin: text typed into the wizard that the scene did not take
   * (a concurrent update closed it meanwhile) goes to no command handler, tracking or AI.
   */
  stopUnhandledInput(context: { update?: TelegramUpdate }, next: Next): Promise<unknown>;
}

export function createConnectWizardGuard(deps: ConnectWizardGuardDeps): ConnectWizardGuard {
  const { sceneStorage, traces } = deps;
  const marks = new WeakMap<{ update?: TelegramUpdate }, WizardInputMark>();

  /** Reads the wizard's scene row and trace and updates the trace — synchronously, see `assertSync`. */
  function inspect(update: TelegramUpdate, userId: number, chatId: number): Verdict {
    const rowKey = connectWizardRowKey(userId, chatId);
    const step = connectWizardStep(
      runWithChatId(chatId, () => assertSync(sceneStorage.get(`@gramio/scenes:${userId}`))),
    );
    const trace = traces.read(rowKey);
    const now = Date.now();
    const message = update.message;
    const edited = update.edited_message;

    if (step !== undefined) {
      traces.write(rowKey, {
        typed: [
          ...(trace?.typed ?? []),
          ...(message?.text !== undefined ? [{ messageId: message.message_id, at: now }] : []),
        ],
        open: true,
        step,
        lastOpenUpdateId: Math.max(trace?.lastOpenUpdateId ?? 0, update.update_id),
        lastOpenAt: now,
      });
      if (message?.text !== undefined) {
        return { kind: 'typed', removeFromChat: step <= LAST_TYPING_STEP && message.text.trim() !== '' };
      }
      return edited?.text !== undefined ? { kind: 'redact' } : NONE;
    }

    if (trace === undefined) return NONE;
    // An edit of a message typed into the wizard — its deletion failed, or it was dropped by the rate limiter.
    if (edited?.text !== undefined) {
      const typedIntoWizard = trace.typed.some((entry) => entry.messageId === edited.message_id);
      return typedIntoWizard ? { kind: 'redact' } : NONE;
    }
    if (message?.text === undefined) return NONE;

    const typed = [...trace.typed, { messageId: message.message_id, at: now }];
    if (
      trace.lastOpenUpdateId !== undefined &&
      update.update_id <= trace.lastOpenUpdateId &&
      now - (trace.lastOpenAt ?? 0) < LATE_DELIVERY_WINDOW_MS
    ) {
      traces.write(rowKey, { ...trace, typed });
      return { kind: 'late' };
    }
    if (trace.open && trace.step >= FIRST_CREDENTIAL_STEP && trace.step <= LAST_TYPING_STEP) {
      // Only this one text answers the abandoned prompt; the wizard counts as closed from here on.
      traces.write(rowKey, {
        ...trace,
        typed,
        open: false,
        lastOpenUpdateId: Math.max(trace.lastOpenUpdateId ?? 0, update.update_id),
        lastOpenAt: now,
      });
      return { kind: 'expired' };
    }
    return NONE;
  }

  async function middleware(context: GuardContext, next: Next) {
    const update = context.update;
    const message = update?.message;
    const edited = update?.edited_message;
    const callback = update?.callback_query;
    const chatId = message?.chat.id ?? edited?.chat.id ?? callback?.message?.chat.id;
    const userId = message?.from?.id ?? edited?.from?.id ?? callback?.from.id;
    if (update === undefined || chatId === undefined || userId === undefined) return next();

    let verdict: Verdict;
    try {
      verdict = inspect(update, userId, chatId);
    } catch (err) {
      // A redacted turn loses less than a logged password.
      guardLogger.warn({ err, userId }, 'connect-wizard state unreadable — logging the text as wizard input');
      if (message?.text !== undefined || edited?.text !== undefined) marks.set(context, 'redact');
      return next();
    }

    switch (verdict.kind) {
      case 'none':
        return next();
      case 'typed':
        marks.set(context, 'typed');
        if (verdict.removeFromChat) await deleteWizardInput(context, userId);
        return next();
      case 'redact':
        marks.set(context, 'redact');
        return next();
      case 'late':
        await deleteWizardInput(context, userId);
        guardLogger.info(
          { userId },
          'text typed into the connect wizard arrived after it closed — deleted, not handled',
        );
        return;
      case 'expired':
        await deleteWizardInput(context, userId);
        guardLogger.info({ userId }, 'text answering an expired connect-wizard prompt — deleted, not handled');
        await context.send?.(t(toLang(context.dbUser?.language)).connectTelegram.wizardExpired, {
          reply_markup: { remove_keyboard: true },
        });
        return;
    }
  }

  return {
    middleware,
    isConnectWizardInput: (context) => marks.has(context),
    async stopUnhandledInput(context, next) {
      if (marks.get(context) !== 'typed') return next();
      guardLogger.info(
        { userId: context.update?.message?.from?.id },
        'text typed into the connect wizard found it closed — not handled',
      );
    },
  };
}

/**
 * Take a message typed into the wizard off the chat: it may hold the phone number, the login code or
 * the 2FA password. A failed deletion is logged without the text; the message id stays in the trace,
 * so a later edit of it is still logged only as the redaction marker.
 */
async function deleteWizardInput(context: GuardContext, userId: number): Promise<void> {
  await context
    .delete?.()
    .catch((err: unknown) =>
      guardLogger.warn({ err, userId }, 'failed to delete a message typed into the connect wizard'),
    );
}
