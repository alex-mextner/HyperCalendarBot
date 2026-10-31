// src/bot/handlers/callback/ai-routes.ts
// AI-driven and recipient/delete confirmation callbacks: ric, dlc, scene help and ai_btn answers.

import type { Lang } from '../../../config/constants.ts';
import { CB, t, toLang } from '../../../config/constants.ts';
import {
  AI_BUTTON_ACTION,
  AI_OPTION_ACTION,
  type InlineKeyboardRows,
  parseAiOptionPayload,
} from '../../../services/ai/ask-user-buttons.ts';
import {
  approveDeletes,
  chooseTargets,
  type DeleteTarget,
  deleteReportForAgent,
  takeDeleteConfirmation,
} from '../../../services/ai/delete-confirmation.ts';
import { confirmRecipientApproval, finishRecipientApproval } from '../../../services/ai/recipient-confirmation.ts';
import { executeTool } from '../../../services/ai/tool-executor.ts';
import { pauseStateFromGramioRecord } from '../../../services/scene-pause.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { isGroup } from '../../group-context.ts';
import type { BotCallbackContext } from '../../types.ts';
import { continueWithAgent } from '../agent-continuation.ts';
import type { CallbackDispatch, CallbackHandlerOpts, CallbackRouteDeps } from './types.ts';

type CallbackHandler = NonNullable<ReturnType<CallbackDispatch['get']>>;

/**
 * Parse ai_btn payload into answer text and optional group restriction.
 * Payload format: "{text}" (private) or "{userId}:{text}" (group).
 *
 * The format is intentionally interpreted with chat context. Without that, a
 * perfectly valid private answer such as "19:00" looks exactly like the legacy
 * group prefix "19:<answer>" and gets truncated to "00". Group callbacks are
 * the only place where a numeric prefix has authorization meaning.
 */
export function parseAiBtnPayload(
  payload: string,
  allowUserRestriction = false,
): { answerText: string; restrictedToUserId?: number } {
  if (allowUserRestriction) {
    const colon = payload.indexOf(':');
    if (colon !== -1 && /^\d+$/.test(payload.slice(0, colon))) {
      return { answerText: payload.slice(colon + 1), restrictedToUserId: Number(payload.slice(0, colon)) };
    }
  }
  return { answerText: payload };
}

/** What a tap on an ask_user button means: the answer, and the one user allowed to give it in a group. */
interface AiButtonTap {
  /** Undefined for an `ai_opt` tap whose message no longer carries the tapped button: answered already, or inaccessible to the bot. */
  answerText: string | undefined;
  restrictedToUserId?: number;
}

/**
 * Reads a tap on either ask_user button form (`ai_btn`, `ai_opt`). `keyboard` is the inline keyboard
 * of the tapped message, where an `ai_opt` button's own label is the answer. Undefined when `data`
 * is not an ask_user button or its payload is malformed.
 */
export function readAiButtonTap(
  data: string,
  inGroup: boolean,
  keyboard: InlineKeyboardRows | undefined,
): AiButtonTap | undefined {
  const firstColon = data.indexOf(':');
  const action = firstColon === -1 ? data : data.slice(0, firstColon);
  const payload = firstColon === -1 ? '' : data.slice(firstColon + 1);
  if (action === AI_BUTTON_ACTION) return parseAiBtnPayload(payload, inGroup);
  if (action !== AI_OPTION_ACTION) return undefined;
  const option = parseAiOptionPayload(payload);
  if (!option) return undefined;
  const tapped = keyboard?.flat().find((button) => button.callback_data === data);
  return { answerText: tapped?.text, ...option };
}

interface DeleteReportLabels {
  deleteDone: (count: number) => string;
  deleteKeptPast: (count: number) => string;
  deleteFailed: (titles: string) => string;
}

/** Telegram refuses a message over 4096 characters; the "✅ " marker and an ellipsis ride on top of the answer. */
const MAX_ACKNOWLEDGED_ANSWER_CHARS = 4000;

/**
 * The answer as shown after "✅ ". One line, because the "already answered" test needs the marker
 * line to end the text, and short enough to be an acceptable message on its own whatever the label.
 */
function acknowledgedAnswer(answerText: string): string {
  const oneLine = answerText.replace(/\s*[\r\n]+\s*/g, ' ');
  return oneLine.length > MAX_ACKNOWLEDGED_ANSWER_CHARS
    ? `${oneLine.slice(0, MAX_ACKNOWLEDGED_ANSWER_CHARS)}…`
    : oneLine;
}

/** A question whose text already ends in a "✅ answer" line: the edit that records an answer landed. */
const ANSWERED_QUESTION = /(?:^|\n\n)✅ [^\n]*$/;

const ANSWERED_MEMORY_LIMIT = 1000;

/**
 * Remembers which question messages were answered, for the taps a client still sends from a message
 * it shows unanswered (the acknowledgement edit failed, or two taps raced before either edit landed).
 * Bounded to the newest ANSWERED_MEMORY_LIMIT messages. A restart forgets it, as it forgets the
 * pending AI turn it guards.
 */
function createAnsweredMessages() {
  const answered = new Set<string>();
  const keyOf = (ctx: BotCallbackContext) =>
    ctx.message?.id === undefined ? undefined : `${ctx.chatId}:${ctx.message.id}`;
  return {
    has: (ctx: BotCallbackContext) => {
      const key = keyOf(ctx);
      return key !== undefined && answered.has(key);
    },
    add: (ctx: BotCallbackContext) => {
      const key = keyOf(ctx);
      if (key === undefined) return;
      answered.add(key);
      // Oldest first: a Set iterates in insertion order.
      const oldest = answered.values().next();
      if (answered.size > ANSWERED_MEMORY_LIMIT && !oldest.done) answered.delete(oldest.value);
    },
    release: (ctx: BotCallbackContext) => {
      const key = keyOf(ctx);
      if (key !== undefined) answered.delete(key);
    },
  };
}

/**
 * One memory for the whole process, not one per handler: src/bot/index.ts builds the callback handler
 * (and so these routes) afresh for every update, so state held inside the handler is empty on each tap.
 * The bot runs as a single container (docker-compose.yml), so process memory sees every tap; Redis
 * would only add a round trip and a failure mode to a guard that the pending AI turn does not outlive.
 */
const answeredMessages = createAnsweredMessages();

async function recordAskUserAnswer(ctx: BotCallbackContext, question: string, answerText: string): Promise<boolean> {
  const entities = ctx.message?.entities?.map((entity) => entity.payload) ?? [];
  const answered = `✅ ${acknowledgedAnswer(answerText)}`;
  const kept = question ? `${question}\n\n${answered}` : answered;
  try {
    try {
      await ctx.editText(kept, { entities });
    } catch (err) {
      // Question plus answer can exceed Telegram's 4096 characters: record the answer alone.
      // editMessageText reports MESSAGE_TOO_LONG, sendMessage 'message is too long'.
      if (kept === answered || !/MESSAGE_TOO_LONG|message is too long/i.test(String(err))) throw err;
      await ctx.editText(answered);
    }
  } catch (err) {
    // Two taps racing on the same question: the second edit changes nothing, so stop here.
    if (String(err).includes('message is not modified')) return false;
    // The edit only shows the answer in the chat; as with the delete confirmation, a failed
    // edit must not drop the user's answer.
    cmdLogger.warn({ err }, 'Failed to record the ask_user answer');
  }
  return true;
}

async function reportDeleteOutcome(
  ctx: BotCallbackContext,
  tr: DeleteReportLabels,
  outcome: { deleted: DeleteTarget[]; kept: DeleteTarget[]; failed: DeleteTarget[] },
): Promise<void> {
  const { deleted, kept, failed } = outcome;
  const question = ctx.message?.text ?? '';
  const entities = ctx.message?.entities?.map((entity) => entity.payload) ?? [];
  const summary = [tr.deleteDone(deleted.length)];
  if (kept.length > 0) summary.push(tr.deleteKeptPast(kept.length));
  if (failed.length > 0) summary.push(tr.deleteFailed(failed.map((target) => `«${target.title}»`).join(', ')));
  // The deletes are done: a failed edit (e.g. over 4096 characters) must not skip the report.
  const result = summary.join('\n');
  try {
    await ctx.editText(question ? `${question}\n\n${result}` : result, { entities });
  } catch {
    await ctx
      .editText(result)
      .catch((err: unknown) => cmdLogger.warn({ err }, 'Failed to edit the delete confirmation'));
  }
}

/**
 * Acknowledges the tap, records the answer in the chat and starts the AI continuation. A callback
 * query too old to answer says nothing about the user's answer, so that failure is only logged.
 */
async function acknowledgeAndContinue(
  ctx: BotCallbackContext,
  userId: number,
  question: string,
  answerText: string,
  onAiButtonClick: CallbackHandlerOpts['onAiButtonClick'],
): Promise<void> {
  await ctx.answer().catch((err: unknown) => cmdLogger.warn({ err }, 'Failed to answer the ask_user tap'));
  const recorded = await recordAskUserAnswer(ctx, question, answerText);
  if (!recorded) return;
  const cbChatId = ctx.chatId;
  if (onAiButtonClick && cbChatId) {
    onAiButtonClick(userId, cbChatId, answerText).catch((e) => {
      cmdLogger.error({ err: e }, 'AI button continuation failed');
    });
  }
}

/** Handler of both ask_user button forms: records the answer once and hands it to the AI. */
function createAskUserTapHandler(onAiButtonClick: CallbackHandlerOpts['onAiButtonClick']): CallbackHandler {
  return async (ctx, _payload, _parts, user, data) => {
    const tap = readAiButtonTap(data, isGroup(ctx), ctx.message?.replyMarkup?.payload.inline_keyboard);
    if (!tap) {
      cmdLogger.warn({ userId: user.telegram_id, action: data.split(':')[0] }, 'ask_user button data is malformed');
      await ctx.answer();
      return;
    }
    const { answerText, restrictedToUserId } = tap;
    const lang = (user.language ?? 'en') as Lang;

    // In groups, only the user who triggered the question can answer
    if (restrictedToUserId !== undefined && ctx.from.id !== restrictedToUserId) {
      await ctx.answer({ text: t(lang).callbackErrors.notYourQuestion, show_alert: false });
      return;
    }

    // Keep the question: after a destructive confirmation it is the user's only record of
    // what they agreed to. Appending at the end leaves the entity offsets valid.
    const question = ctx.message?.text ?? '';
    // A later tap from a client that still shows the buttons finds an answer already recorded,
    // the same option or another one: the AI must not get a second answer (a destructive
    // confirmation would run again, or run after the user declined it). The recorded answer is
    // either the "✅" line of the edited message or, when that edit failed or has not landed yet,
    // this process's memory of the message. Answering removes the keyboard, so a late `ai_opt`
    // tap has no label to read: this test comes before that one.
    if (ANSWERED_QUESTION.test(question) || answeredMessages.has(ctx)) {
      await ctx.answer();
      cmdLogger.info({ userId: user.telegram_id }, 'ai_btn tap on an already answered question ignored');
      return;
    }
    if (answerText === undefined) {
      cmdLogger.warn({ userId: user.telegram_id }, 'ai_opt tap found no matching button in the tapped message');
      await ctx.answer({ text: t(lang).callbackErrors.unavailable, show_alert: true });
      return;
    }
    // Claimed before the first await: a second tap arriving while the edit is in flight sees it.
    answeredMessages.add(ctx);
    try {
      await acknowledgeAndContinue(ctx, user.telegram_id, question, answerText, onAiButtonClick);
    } catch (err) {
      // The answer never reached the AI: release the claim so the user's retap is processed, not ignored.
      answeredMessages.release(ctx);
      throw err;
    }
  };
}

export function registerAiRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { onAiButtonClick, agentContinuation, scenePauseDeps } = deps.opts;

  dispatch.set('ric', async (ctx, payload, _parts, user) => {
    const answer = async (text?: string) => {
      await ctx.answer(text ? { text } : undefined).catch(() => {});
    };
    if (!agentContinuation || ctx.from.id !== user.telegram_id) {
      await answer(t(user.language).aiTools.meta.recipientUnverified);
      return;
    }
    const approved = confirmRecipientApproval(payload, ctx.from.id, Number(ctx.chatId));
    if (!approved) {
      await answer(t(user.language).aiTools.meta.recipientUnverified);
      return;
    }
    await answer();
    try {
      await continueWithAgent(
        user,
        `Confirmed recipient Telegram ID ${approved.recipientId} for event ${approved.eventId}. Send that invitation with force=true; do not change the ID or use a conflicting username.`,
        agentContinuation,
      );
      finishRecipientApproval(payload, false);
    } catch (error) {
      finishRecipientApproval(payload, true);
      throw error;
    }
  });

  // Bot-rendered delete list (ask_user with event_ids): delete exactly the tapped set here, so a
  // model that deletes a different set, or no AI at all, cannot change what was confirmed.
  dispatch.set('dlc', async (ctx, payload, _parts, user) => {
    const tr = t(toLang(user.language)).aiTools.meta;
    const [confirmationId = '', choice = ''] = payload.split(':');
    const chatId = Number(ctx.chatId);
    const targets =
      agentContinuation && ['u', 'a', 'x'].includes(choice)
        ? takeDeleteConfirmation(confirmationId, ctx.from.id, chatId)
        : null;
    if (!agentContinuation || !targets) {
      await ctx.answer({ text: tr.deleteConfirmExpired, show_alert: true }).catch(() => {});
      return;
    }
    await ctx.answer().catch(() => {});
    const question = ctx.message?.text ?? '';
    const entities = ctx.message?.entities?.map((entity) => entity.payload) ?? [];
    const withResult = (result: string) => (question ? `${question}\n\n${result}` : result);
    if (choice === 'x') {
      await ctx.editText(withResult(tr.deleteCancelled), { entities });
      return;
    }

    const chosen = chooseTargets(targets, choice === 'a' ? 'all' : 'upcoming');
    approveDeletes(
      user.telegram_id,
      chatId,
      chosen.map((target) => target.eventId),
    );
    const groupInfo = chatId === user.telegram_id ? undefined : { isGroup: true, groupChatId: chatId };
    const agentCtx = agentContinuation.buildContext(user, chatId, '', groupInfo);
    const deleted: DeleteTarget[] = [];
    const failed: DeleteTarget[] = [];
    for (const target of chosen) {
      const result = await executeTool(agentCtx, 'delete_event', {
        event_id: target.eventId,
        scope: target.scope,
        ...(target.ownerId !== undefined && { owner_id: target.ownerId }),
      });
      (result.success ? deleted : failed).push(target);
    }
    const kept = targets.filter((target) => !chosen.includes(target));
    await reportDeleteOutcome(ctx, tr, { deleted, kept, failed });
    await continueWithAgent(
      user,
      deleteReportForAgent({ deleted, kept, failed }, user.timezone),
      agentContinuation,
      chatId,
      agentCtx.changedDays,
    ).catch((err: unknown) => cmdLogger.error({ err }, 'AI continuation after delete confirmation failed'));
  });

  // Scene help — user asked AI for help during wizard
  dispatch.set(CB.SCENE_HELP, async (ctx, _payload, _parts, user) => {
    await ctx.answer();
    if (!scenePauseDeps) return;

    const rawScene = await scenePauseDeps.sceneStorage.get(`@gramio/scenes:${user.telegram_id}`);
    if (!rawScene) return;

    await scenePauseDeps.scenePauseService.save(user.telegram_id, pauseStateFromGramioRecord(rawScene));

    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).callbackErrors.sceneHelpPrompt);
  });

  // AI ask_user button responses — trigger AI continuation
  const handleTap = createAskUserTapHandler(onAiButtonClick);
  for (const action of [AI_BUTTON_ACTION, AI_OPTION_ACTION]) dispatch.set(action, handleTap);
}
