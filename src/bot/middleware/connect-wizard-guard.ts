// src/bot/middleware/connect-wizard-guard.ts
// Recognises text typed into the Telegram-connect wizard — a phone number, login code or 2FA
// password — before anything else handles the update (the rate limiter included) and takes it off
// the chat. It also recognises such text where the wizard's scene row can no longer show it: text sent
// before a concurrent cancel but handled after it, the answer to a credential prompt whose idle wizard
// expired, and text in a chat whose open wizard's scene row cannot be read (GH-519, GH-639).
//
// Every such input leaves one redaction-marker row in chat_history and an audit row in
// user_action_log (reason, step, message id, deletion and outcome — never the text, its length or a
// digest). The answer to an expired prompt, and text whose wizard state is unreadable, is held in
// memory only: the owner may release it once as an ordinary request or discard it (GH-645). A cancel
// button names its run of the wizard; pressed after the wizard is gone it closes that run's trace,
// and one from an earlier run cannot end a newer one.

import { randomBytes } from 'node:crypto';
import { InlineKeyboard, type Next, type TelegramUpdate } from 'gramio';
import { t, toLang } from '../../config/constants.ts';
import type { ActionLogRepository } from '../../database/repositories/action-log.repository.ts';
import type { User } from '../../database/types.ts';
import type { ConversationLogger } from '../../services/conversation-logger.ts';
import { logger } from '../../utils/logger.ts';
import { describeFailure } from '../../utils/safe-failure.ts';
import { runWithChatId } from '../scenes/chat-scoped-storage.ts';
import {
  abortConnectAuth,
  type CancelButton,
  CONNECT_WIZARD_REDACTION,
  parseCancelButton,
} from '../scenes/connect-telegram.scene.ts';
import {
  assertSync,
  type ConnectWizardRow,
  type ConnectWizardTrace,
  type ConnectWizardTraces,
  connectWizardRow,
  connectWizardRowKey,
} from '../scenes/connect-wizard-trace.ts';

const guardLogger = logger.child({ module: 'connect-wizard-guard' });

/** The consent screen (0) and the phone, code and 2FA prompts (1–3) read typed text; 1–3 ask for a credential. */
const FIRST_CREDENTIAL_STEP = 1;
/** The phone prompt: the only step that shows the "share phone number" reply keyboard. */
const PHONE_STEP = 1;
const LAST_TYPING_STEP = 3;
const STEP_NAMES = ['consent', 'phone', 'code', 'password', 'pending_invitations'];
/**
 * Update ids grow with every update the bot receives, so a text whose id is not above the latest update
 * handled while the wizard was open was sent while it was open. Concurrent deliveries are seconds apart,
 * and Telegram may restart the numbering after a week without updates, so this holds only briefly.
 */
const LATE_DELIVERY_WINDOW_MS = 5 * 60 * 1000;
/** A held message waits this long for its owner's answer; a restart forgets it sooner. */
const HELD_TTL_MS = 15 * 60 * 1000;
/** Held messages kept per user and in all, so that a flood cannot grow memory. */
const MAX_HELD_PER_USER = 3;
const MAX_HELD_TOTAL = 100;
/** `ctw:p:<nonce>` releases a held message, `ctw:d:<nonce>` discards it. */
const CB_HELD = 'ctw';

/** `action_type` of the audit rows this guard writes. */
export const CONNECT_WIZARD_AUDIT = 'connect_wizard_input';

type ReplyFn = (text: string, opts?: { [key: string]: unknown }) => Promise<unknown>;

/** The part of a GramIO context the guard reads; the methods exist on message or callback contexts. */
interface GuardContext {
  update?: TelegramUpdate;
  dbUser?: User;
  send?: ReplyFn;
  editText?: ReplyFn;
  answer?: (opts?: { text?: string }) => Promise<unknown>;
  delete?: () => Promise<unknown>;
}

type AuditReason =
  | 'typed'
  | 'slash'
  | 'edited'
  | 'late'
  | 'rate_limited'
  | 'expired'
  | 'state_unreadable'
  | 'released'
  | 'discarded'
  | 'release_refused'
  | 'opened'
  | 'replayed';
type Deletion = 'deleted' | 'failed' | 'not_attempted';
type HoldReason = 'expired' | 'state_unreadable';

/** Who sent a protected input where, and the chat_history marker row it left. */
interface InputRef {
  userId: number;
  chatId: number;
  messageId: number;
  step?: number;
  historyRowId?: number;
}

/**
 * `typed`: text typed into the open wizard — only its scene may handle it.
 * `redact`: an edit of wizard input, or of text in a chat whose wizard state could not be read.
 */
interface Recorded extends InputRef {
  kind: 'typed' | 'redact';
}

interface HeldMessage extends InputRef {
  update: TelegramUpdate;
  reason: HoldReason;
  /** The run of the wizard the message may have been typed into, as the trace named it when held. */
  wizardId?: string;
  expiresAt: number;
  /** Takes the message out of memory at its expiry. */
  timer: NodeJS.Timeout;
}

type Verdict =
  /**
   * Not wizard input. `openRun`: the run of the wizard open before this update ('' for a run started
   * before runs were named), undefined when none was open, null when the guard cannot tell.
   */
  | { kind: 'none'; openRun: string | null | undefined }
  | { kind: 'typed'; step: number; removeFromChat: boolean }
  | { kind: 'redact'; step?: number }
  /** Sent while the wizard was open, handled after it closed. */
  | { kind: 'late'; step: number }
  /** The answer to an expired credential prompt, or text whose wizard state could not be read. */
  | { kind: 'hold'; reason: HoldReason; step?: number; wizardId?: string };

export interface ConnectWizardGuardDeps {
  /** Chat-scoped scene storage (`@gramio/scenes:<userId>` keys). */
  sceneStorage: { get(key: string): unknown; delete(key: string): unknown };
  traces: ConnectWizardTraces;
  conversationLogger: ConversationLogger;
  actionLog: Pick<ActionLogRepository, 'insert'>;
  /** Runs a held message through the whole bot, once its owner released it. */
  replay: (update: TelegramUpdate) => Promise<unknown>;
}

export interface ConnectWizardGuard {
  /** Registered before the rate limiter, so that input it drops is still taken off the chat. */
  middleware(context: GuardContext, next: Next): Promise<unknown>;
  /** The rate limiter's report of an update it dropped: wizard input gets an audit row that says so. */
  recordRateLimited(context: { update?: TelegramUpdate }): void;
  /** Whether the guard already stored this update's text or edit (as the marker) — chat logging stores nothing. */
  isConnectWizardInput(context: { update?: TelegramUpdate }): boolean;
  /** Whether this update is a held message its owner released, on its way through the bot again. */
  isOwnerReleased(context: { update?: TelegramUpdate }): boolean;
  /** How many messages are held in memory for their owner's decision (bounded; for health checks and tests). */
  heldMessageCount(): number;
  /**
   * Registered right after chat logging, which logs the press: the buttons under a held message, and
   * cancel buttons whose run of the wizard is no longer the open one.
   */
  callbacks(context: GuardContext, next: Next): Promise<unknown>;
  /**
   * Registered right after the scenes plugin: text typed into the wizard that the scene did not take
   * (a concurrent update closed it meanwhile) goes to no command handler, tracking or AI.
   */
  stopUnhandledInput(context: { update?: TelegramUpdate }, next: Next): Promise<unknown>;
}

export function createConnectWizardGuard(deps: ConnectWizardGuardDeps): ConnectWizardGuard {
  const { sceneStorage, traces, conversationLogger, actionLog, replay } = deps;
  const recorded = new WeakMap<{ update?: TelegramUpdate }, Recorded>();
  /** Nonce → held message. Memory only: a restart forgets every held message. Insertion order is age. */
  const heldMessages = new Map<string, HeldMessage>();
  /**
   * Held messages their owner released, on their way through the bot a second time. Weak: an entry
   * lives as long as that replayed update, so later middleware can still recognise it.
   */
  const released = new WeakSet<TelegramUpdate>();

  function readSceneRow(userId: number, chatId: number): ConnectWizardRow | undefined {
    return connectWizardRow(runWithChatId(chatId, () => assertSync(sceneStorage.get(`@gramio/scenes:${userId}`))));
  }

  /** Reads the wizard's scene row and trace and updates the trace — synchronously, see `assertSync`. */
  function inspect(update: TelegramUpdate, userId: number, chatId: number): Verdict {
    const rowKey = connectWizardRowKey(userId, chatId);
    let row: ConnectWizardRow | undefined | 'unreadable';
    try {
      row = readSceneRow(userId, chatId);
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId, chatId },
        'connect-wizard scene row unreadable — deciding from the trace',
      );
      row = 'unreadable';
    }
    const trace = traces.read(rowKey);
    const now = Date.now();
    const message = update.message;
    const edited = update.edited_message;

    if (row !== undefined && row !== 'unreadable') {
      traces.write(rowKey, {
        typed: [
          ...(trace?.typed ?? []),
          ...(message?.text !== undefined ? [{ messageId: message.message_id, at: now }] : []),
        ],
        open: true,
        step: row.step,
        wizardId: row.wizardId,
        sessionPath: row.sessionPath,
        lastOpenUpdateId: Math.max(trace?.lastOpenUpdateId ?? 0, update.update_id),
        lastOpenAt: now,
      });
      if (message?.text !== undefined) {
        return {
          kind: 'typed',
          step: row.step,
          removeFromChat: row.step <= LAST_TYPING_STEP && message.text.trim() !== '',
        };
      }
      return edited?.text !== undefined
        ? { kind: 'redact', step: row.step }
        : { kind: 'none', openRun: row.wizardId ?? '' };
    }

    const openRunBefore = trace?.open ? (trace.wizardId ?? '') : undefined;
    const notInput: Verdict = { kind: 'none', openRun: row === 'unreadable' ? null : openRunBefore };
    if (trace === undefined) return notInput;
    // Another scene row would have closed the trace, so an open trace with an unreadable row may be the wizard.
    const mayBeInWizard = row === 'unreadable' && trace.open;
    // An edit of a message typed into the wizard — its deletion failed, or it was dropped by the rate limiter.
    if (edited?.text !== undefined) {
      const typedIntoWizard = trace.typed.some((entry) => entry.messageId === edited.message_id);
      return typedIntoWizard || mayBeInWizard ? { kind: 'redact', step: trace.step } : notInput;
    }
    if (message?.text === undefined) return notInput;

    const typed = [...trace.typed, { messageId: message.message_id, at: now }];
    if (
      trace.lastOpenUpdateId !== undefined &&
      update.update_id <= trace.lastOpenUpdateId &&
      now - (trace.lastOpenAt ?? 0) < LATE_DELIVERY_WINDOW_MS
    ) {
      traces.write(rowKey, { ...trace, typed });
      return { kind: 'late', step: trace.step };
    }
    if (mayBeInWizard) {
      traces.write(rowKey, { ...trace, typed });
      return { kind: 'hold', reason: 'state_unreadable', step: trace.step, wizardId: trace.wizardId };
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
      return { kind: 'hold', reason: 'expired', step: trace.step, wizardId: trace.wizardId };
    }
    return notInput;
  }

  /** The redaction-marker row for a protected text or edit, written before anything else answers it. */
  function logMarker(context: GuardContext, ref: InputRef, edit: boolean): number | undefined {
    const user = context.dbUser;
    if (!user) {
      guardLogger.warn({ userId: ref.userId }, 'connect-wizard input from an unresolved user — no history row');
      return undefined;
    }
    const logChatId = ref.chatId === user.telegram_id ? undefined : ref.chatId;
    try {
      return edit
        ? conversationLogger.logEditedMessage(user.telegram_id, CONNECT_WIZARD_REDACTION, logChatId)
        : conversationLogger.logUserMessage(user.telegram_id, CONNECT_WIZARD_REDACTION, logChatId);
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: ref.userId, chatId: ref.chatId, messageId: ref.messageId },
        'connect-wizard marker row not written',
      );
      return undefined;
    }
  }

  function audit(ref: InputRef, reason: AuditReason, details: { deletion?: Deletion; outcome: string }): void {
    try {
      actionLog.insert({
        user_id: ref.userId,
        chat_id: ref.chatId,
        action_type: CONNECT_WIZARD_AUDIT,
        action_name: reason,
        message_id: ref.messageId,
        chat_history_id: ref.historyRowId,
        metadata: JSON.stringify({
          step: ref.step === undefined ? undefined : (STEP_NAMES[ref.step] ?? 'unknown'),
          deletion: details.deletion,
          outcome: details.outcome,
        }),
        success: details.deletion !== 'failed',
      });
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: ref.userId, chatId: ref.chatId, messageId: ref.messageId, reason },
        'connect-wizard audit row not written',
      );
    }
  }

  /** Drops a held message from memory, with its expiry timer. */
  function forget(nonce: string): void {
    const held = heldMessages.get(nonce);
    if (held === undefined) return;
    clearTimeout(held.timer);
    heldMessages.delete(nonce);
  }

  /** Keeps a message in memory for its owner's decision; returns the nonce its buttons carry. */
  function hold(ref: InputRef, update: TelegramUpdate, reason: HoldReason, wizardId: string | undefined): string {
    const own = [...heldMessages].filter(([, held]) => held.userId === ref.userId);
    for (const [nonce] of own.slice(0, Math.max(0, own.length - MAX_HELD_PER_USER + 1))) forget(nonce);
    for (const nonce of heldMessages.keys()) {
      if (heldMessages.size < MAX_HELD_TOTAL) break;
      forget(nonce);
    }
    const nonce = randomBytes(12).toString('base64url');
    // A one-shot timer, not a queued job: the held text must never leave this process's memory.
    const timer = setTimeout(() => forget(nonce), HELD_TTL_MS);
    timer.unref();
    heldMessages.set(nonce, { ...ref, update, reason, wizardId, expiresAt: Date.now() + HELD_TTL_MS, timer });
    return nonce;
  }

  /**
   * Takes a held message out for its owner and chat, in one synchronous step: a second press finds
   * nothing. A press from anyone else takes nothing.
   */
  function takeHeld(nonce: string, userId: number, chatId: number): HeldMessage | 'gone' | 'foreign' {
    const held = heldMessages.get(nonce);
    if (held === undefined || held.expiresAt <= Date.now()) {
      forget(nonce);
      return 'gone';
    }
    if (held.userId !== userId || held.chatId !== chatId) return 'foreign';
    forget(nonce);
    return held;
  }

  /**
   * Before a released message runs as an ordinary request, the wizard it may have been typed into must
   * not take it: ends that run (its scene row, its trace, and then its login). A newer run, or a state
   * that still cannot be read, makes the release unsafe — the message is not processed.
   */
  function endHeldWizard(held: HeldMessage, closingUpdateId: number): { ended: boolean; state?: unknown } | 'unsafe' {
    const key = `@gramio/scenes:${held.userId}`;
    const rowKey = connectWizardRowKey(held.userId, held.chatId);
    try {
      return runWithChatId(held.chatId, () => {
        const raw = assertSync(sceneStorage.get(key));
        const row = connectWizardRow(raw);
        const ownRun = held.reason === 'state_unreadable' && row?.wizardId === held.wizardId;
        if (row !== undefined) {
          if (!ownRun) return 'unsafe';
          // Deleting the row through the tracked store closes its trace too.
          assertSync(sceneStorage.delete(key));
          return {
            ended: true,
            state: typeof raw === 'object' && raw !== null && 'state' in raw ? raw.state : undefined,
          };
        }
        const trace = traces.read(rowKey);
        if (held.reason === 'state_unreadable' && trace?.open && trace.wizardId === held.wizardId) {
          closeTrace(rowKey, trace, closingUpdateId);
          return { ended: true, state: { sessionPath: trace.sessionPath } };
        }
        return { ended: false };
      });
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: held.userId, chatId: held.chatId, messageId: held.messageId },
        'connect-wizard state unreadable at release — the held message is not processed',
      );
      return 'unsafe';
    }
  }

  /**
   * Closes a run's trace as of the update that closed it, so that text sent before that update but
   * handled after it still counts as late.
   */
  function closeTrace(rowKey: string, trace: ConnectWizardTrace, closingUpdateId: number): void {
    traces.write(rowKey, {
      ...trace,
      open: false,
      lastOpenUpdateId: Math.max(trace.lastOpenUpdateId ?? 0, closingUpdateId),
      lastOpenAt: Date.now(),
    });
  }

  /** The run open in a chat's trace now; null when the trace cannot be read. */
  function openRunNow(userId: number, chatId: number): string | null | undefined {
    try {
      const trace = traces.read(connectWizardRowKey(userId, chatId));
      return trace?.open ? (trace.wizardId ?? '') : undefined;
    } catch (err) {
      guardLogger.warn({ ...describeFailure(err), userId, chatId }, 'connect-wizard trace unreadable');
      return null;
    }
  }

  /** Hands an update that is not wizard input on; records the opening of a run if it opened one. */
  async function passOn(
    next: Next,
    ref: Omit<InputRef, 'messageId'> & { messageId?: number },
    openRun: string | null | undefined,
  ) {
    if (openRun === null || ref.messageId === undefined) return next();
    const result = await next();
    let trace: ConnectWizardTrace | undefined;
    try {
      trace = traces.read(connectWizardRowKey(ref.userId, ref.chatId));
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: ref.userId, chatId: ref.chatId },
        'connect-wizard trace unreadable',
      );
      return result;
    }
    if (trace?.open && (trace.wizardId ?? '') !== openRun) {
      audit({ ...ref, messageId: ref.messageId, step: trace.step }, 'opened', { outcome: 'opened' });
    }
    return result;
  }

  async function middleware(context: GuardContext, next: Next) {
    const update = context.update;
    const message = update?.message;
    const edited = update?.edited_message;
    const callback = update?.callback_query;
    const chatId = message?.chat.id ?? edited?.chat.id ?? callback?.message?.chat.id;
    const userId = message?.from?.id ?? edited?.from?.id ?? callback?.from.id;
    if (update === undefined || chatId === undefined || userId === undefined) return next();
    const updateMessageId = message?.message_id ?? callback?.message?.message_id;
    // Released by its owner: an ordinary request from here on.
    if (released.has(update)) {
      return passOn(next, { userId, chatId, messageId: updateMessageId }, openRunNow(userId, chatId));
    }

    let verdict: Verdict;
    try {
      verdict = inspect(update, userId, chatId);
    } catch (err) {
      // Neither the scene row nor the trace can tell; the wizard lives in private chats only.
      guardLogger.warn({ ...describeFailure(err), userId, chatId }, 'connect-wizard trace unreadable');
      const isPrivate = (message ?? edited)?.chat.type === 'private';
      if (message?.text !== undefined && isPrivate) verdict = { kind: 'hold', reason: 'state_unreadable' };
      else verdict = edited?.text !== undefined ? { kind: 'redact' } : { kind: 'none', openRun: null };
    }
    if (verdict.kind === 'none') {
      return passOn(next, { userId, chatId, messageId: updateMessageId }, verdict.openRun);
    }
    const messageId = (message ?? edited)?.message_id;
    if (messageId === undefined) return next();
    const ref: InputRef = { userId, chatId, messageId, step: verdict.step };
    ref.historyRowId = logMarker(context, ref, verdict.kind === 'redact');

    switch (verdict.kind) {
      case 'redact':
        recorded.set(context, { ...ref, kind: 'redact' });
        audit(ref, 'edited', { outcome: 'logged_as_marker' });
        return next();
      case 'typed': {
        recorded.set(context, { ...ref, kind: 'typed' });
        const slash = message?.text?.trimStart().startsWith('/') === true;
        const deletion = verdict.removeFromChat ? await deleteWizardInput(context, userId) : 'not_attempted';
        audit(ref, slash ? 'slash' : 'typed', { deletion, outcome: slash ? 'ends_wizard' : 'to_wizard' });
        return next();
      }
      case 'late': {
        const deletion = await deleteWizardInput(context, userId);
        audit(ref, 'late', { deletion, outcome: 'dropped' });
        guardLogger.info(
          { userId },
          'text typed into the connect wizard arrived after it closed — deleted, not handled',
        );
        return;
      }
      case 'hold': {
        const deletion = await deleteWizardInput(context, userId);
        const nonce = hold(ref, update, verdict.reason, verdict.wizardId);
        audit(ref, verdict.reason, { deletion, outcome: 'held' });
        guardLogger.info({ userId, reason: verdict.reason }, 'connect-wizard input held for its owner to release');
        await sendHeldNotice(context, ref, nonce, verdict.reason);
        return;
      }
    }
  }

  /** Asks the owner what to do with a held message, without repeating it, and logs the question. */
  async function sendHeldNotice(context: GuardContext, ref: InputRef, nonce: string, reason: HoldReason) {
    const ct = t(toLang(context.dbUser?.language)).connectTelegram;
    const notice = reason === 'expired' ? ct.wizardExpired : ct.wizardStateUnknown;
    // A message carries one keyboard: the phone prompt's reply keyboard (whose button would send the phone
    // number) is removed by a throwaway message, as the scene installs it.
    if (ref.step === undefined || ref.step === PHONE_STEP) {
      await bestEffort(ref, 'phone-share keyboard not removed', async () => {
        const cleared: unknown = await context.send?.('…', { reply_markup: { remove_keyboard: true } });
        if (isDeletable(cleared)) await cleared.delete();
      });
    }
    const keyboard = new InlineKeyboard()
      .text(ct.btnProcessHeld, `${CB_HELD}:p:${nonce}`)
      .text(ct.btnDiscardHeld, `${CB_HELD}:d:${nonce}`);
    try {
      await context.send?.(notice, { reply_markup: keyboard });
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: ref.userId, chatId: ref.chatId, messageId: ref.messageId },
        'held-message notice not sent — the message stays held until it expires',
      );
      return;
    }
    const user = context.dbUser;
    if (user)
      conversationLogger.logBotResponse(
        user.telegram_id,
        notice,
        ref.chatId === user.telegram_id ? undefined : ref.chatId,
      );
  }

  async function answerHeldButton(
    context: GuardContext,
    action: string,
    nonce: string,
    userId: number,
    chatId: number,
    updateId: number,
  ) {
    const ct = t(toLang(context.dbUser?.language)).connectTelegram;
    const held = takeHeld(nonce, userId, chatId);
    if (held === 'foreign') {
      guardLogger.warn({ userId, chatId }, 'held-message button pressed outside its owner and chat — ignored');
      await context.answer?.();
      return;
    }
    if (held === 'gone') {
      await context.answer?.();
      await context.editText?.(ct.heldGone);
      return;
    }
    if (action !== 'p') {
      audit(held, 'discarded', { outcome: 'discarded' });
      await context.answer?.();
      await context.editText?.(ct.heldDiscarded);
      return;
    }
    // Still synchronous with taking it out: nothing can interleave before the wizard question is settled.
    const wizard = endHeldWizard(held, updateId);
    if (wizard === 'unsafe') {
      audit(held, 'release_refused', { outcome: 'not_processed' });
      await context.answer?.();
      await context.editText?.(ct.heldGone);
      return;
    }
    audit(held, 'released', { outcome: 'processing' });
    await bestEffort(held, 'held-message press not answered', () => context.answer?.());
    await bestEffort(held, 'held-message notice not updated', () => context.editText?.(ct.heldProcessing));
    if (wizard.ended) {
      await bestEffort(held, 'login of the ended connect wizard not stopped', () =>
        abortConnectAuth(held.userId, wizard.state),
      );
      await bestEffort(held, 'connect-wizard end not announced', () =>
        context.send?.(ct.authCancelled, { reply_markup: { remove_keyboard: true } }),
      );
    }
    released.add(held.update);
    try {
      await replay(held.update);
    } catch (err) {
      // Not retried: the request may have run in part.
      audit(held, 'replayed', { outcome: 'failed' });
      guardLogger.warn(
        { ...describeFailure(err), userId: held.userId, chatId: held.chatId, messageId: held.messageId },
        'released message failed while it was processed',
      );
      return;
    }
    // handleUpdate reports handler errors to the bot's error hook, not here: the release was handed to
    // the bot, which is all this row claims.
    audit(held, 'replayed', { outcome: 'dispatched' });
  }

  /** A notice or cleanup around a release: its failure is logged safely and never stops the release. */
  async function bestEffort(ref: InputRef, failure: string, step: () => Promise<unknown> | undefined): Promise<void> {
    try {
      await step();
    } catch (err) {
      guardLogger.warn(
        { ...describeFailure(err), userId: ref.userId, chatId: ref.chatId, messageId: ref.messageId },
        failure,
      );
    }
  }

  async function answerCancelButton(
    context: GuardContext,
    button: CancelButton,
    updateId: number,
    userId: number,
    chatId: number,
    next: Next,
  ) {
    const ct = t(toLang(context.dbUser?.language)).connectTelegram;
    const rowKey = connectWizardRowKey(userId, chatId);
    let row: ConnectWizardRow | undefined;
    try {
      row = readSceneRow(userId, chatId);
    } catch (err) {
      // Unreadable: this button may be from an earlier run, so it ends nothing.
      guardLogger.warn({ ...describeFailure(err), userId, chatId }, 'connect-wizard scene row unreadable at cancel');
      await context.answer?.({ text: ct.staleCancel });
      return;
    }
    // The open run's own button: its scene ends it.
    if (row !== undefined && row.wizardId === button.wizardId) return next();
    const trace = row === undefined ? traces.read(rowKey) : undefined;
    if (trace?.open && trace.wizardId === button.wizardId) {
      // The run's scene row expired together with its state: close the run, stop its login process.
      closeTrace(rowKey, trace, updateId);
      await abortConnectAuth(userId, { sessionPath: trace.sessionPath });
      await context.answer?.();
      const reply = button.kind === 'auth' ? ct.authCancelled : ct.cancelled;
      await context.send?.(reply, { reply_markup: { remove_keyboard: true } });
      guardLogger.info({ userId }, 'cancel pressed after the connect wizard expired — closed');
      return;
    }
    await context.answer?.({ text: ct.staleCancel });
  }

  return {
    middleware,
    recordRateLimited(context) {
      const entry = recorded.get(context);
      if (entry?.kind === 'typed') audit(entry, 'rate_limited', { outcome: 'dropped' });
    },
    isConnectWizardInput: (context) => recorded.has(context),
    isOwnerReleased: (context) => context.update !== undefined && released.has(context.update),
    heldMessageCount: () => heldMessages.size,
    async callbacks(context, next) {
      const callback = context.update?.callback_query;
      const chatId = callback?.message?.chat.id;
      const updateId = context.update?.update_id;
      if (callback?.data === undefined || chatId === undefined || updateId === undefined) return next();
      const [prefix, action, nonce] = callback.data.split(':');
      if (prefix === CB_HELD && action !== undefined && nonce !== undefined) {
        return answerHeldButton(context, action, nonce, callback.from.id, chatId, updateId);
      }
      const cancel = parseCancelButton(callback.data);
      if (cancel !== undefined) {
        return answerCancelButton(context, cancel, updateId, callback.from.id, chatId, next);
      }
      return next();
    },
    async stopUnhandledInput(context, next) {
      if (recorded.get(context)?.kind !== 'typed') return next();
      guardLogger.info(
        { userId: context.update?.message?.from?.id },
        'text typed into the connect wizard found it closed — not handled',
      );
    },
  };
}

/** A sent message whose context can delete it. */
function isDeletable(value: unknown): value is { delete(): Promise<unknown> } {
  return typeof value === 'object' && value !== null && 'delete' in value && typeof value.delete === 'function';
}

/**
 * Take a message typed into the wizard off the chat: it may hold the phone number, the login code or
 * the 2FA password. A failed deletion is logged without the text; the message id stays in the trace,
 * so a later edit of it is still logged only as the redaction marker.
 */
async function deleteWizardInput(context: GuardContext, userId: number): Promise<Deletion> {
  if (context.delete === undefined) return 'not_attempted';
  try {
    await context.delete();
    return 'deleted';
  } catch (err) {
    guardLogger.warn({ ...describeFailure(err), userId }, 'failed to delete a message typed into the connect wizard');
    return 'failed';
  }
}
