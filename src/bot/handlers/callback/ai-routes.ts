// src/bot/handlers/callback/ai-routes.ts
// AI-driven and recipient/delete confirmation callbacks: ric, dlc, scene help and ai_btn answers.

import type { Lang } from '../../../config/constants.ts';
import { CB, t, toLang } from '../../../config/constants.ts';
import {
  approveDeletes,
  chooseTargets,
  type DeleteTarget,
  deleteReportForAgent,
  takeDeleteConfirmation,
} from '../../../services/ai/delete-confirmation.ts';
import { confirmRecipientApproval, finishRecipientApproval } from '../../../services/ai/recipient-confirmation.ts';
import { executeTool } from '../../../services/ai/tool-executor.ts';
import type { SceneName } from '../../../services/scene-pause.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { isGroup } from '../../group-context.ts';
import type { BotCallbackContext } from '../../types.ts';
import { continueWithAgent } from '../agent-continuation.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

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

interface DeleteReportLabels {
  deleteDone: (count: number) => string;
  deleteKeptPast: (count: number) => string;
  deleteFailed: (titles: string) => string;
}

async function recordAskUserAnswer(ctx: BotCallbackContext, question: string, answerText: string): Promise<boolean> {
  const entities = ctx.message?.entities?.map((entity) => entity.payload) ?? [];
  const answered = `✅ ${answerText}`;
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

    const KNOWN_SCENES: SceneName[] = ['add_event', 'timezone', 'onboarding', 'edit_value', 'import'];
    let sceneName: SceneName = 'add_event';
    let step = 0;
    let sceneState: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawScene as string) as Record<string, unknown>;
      const parsedName = (parsed.name as string) ?? 'add_event';
      sceneName = (KNOWN_SCENES.includes(parsedName as SceneName) ? parsedName : 'add_event') as SceneName;
      step = (parsed.step as number) ?? 0;
      sceneState = (parsed.state as Record<string, unknown>) ?? {};
    } catch {
      // proceed with defaults
    }

    await scenePauseDeps.scenePauseService.save(user.telegram_id, { sceneName, step, sceneState });

    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).callbackErrors.sceneHelpPrompt);
  });

  // AI ask_user button responses — trigger AI continuation
  dispatch.set('ai_btn', async (ctx, _payload, _parts, user, data) => {
    const firstColon = data.indexOf(':');
    const { answerText, restrictedToUserId } = parseAiBtnPayload(data.slice(firstColon + 1), isGroup(ctx));
    const lang = (user.language ?? 'en') as Lang;

    // In groups, only the user who triggered the question can answer
    const clickerId = ctx.from.id;
    if (restrictedToUserId !== undefined && clickerId !== restrictedToUserId) {
      await ctx.answer({ text: t(lang).callbackErrors.notYourQuestion, show_alert: false });
      return;
    }

    await ctx.answer();
    // Keep the question: after a destructive confirmation it is the user's only record of
    // what they agreed to. Appending at the end leaves the entity offsets valid.
    const question = ctx.message?.text ?? '';
    // A later tap from a client that still shows the buttons finds an answer already recorded,
    // the same option or another one: the AI must not get a second answer (a destructive
    // confirmation would run again, or run after the user declined it).
    if (/(?:^|\n\n)✅ [^\n]*$/.test(question)) {
      cmdLogger.info({ userId: user.telegram_id }, 'ai_btn tap on an already answered question ignored');
      return;
    }
    const recorded = await recordAskUserAnswer(ctx, question, answerText);
    if (!recorded) return;
    const cbChatId = ctx.chatId;
    if (onAiButtonClick && cbChatId) {
      onAiButtonClick(user.telegram_id, cbChatId, answerText).catch((e) => {
        cmdLogger.error({ err: e }, 'AI button continuation failed');
      });
    }
  });
}
