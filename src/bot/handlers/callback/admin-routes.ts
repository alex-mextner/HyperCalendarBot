// src/bot/handlers/callback/admin-routes.ts
// Admin-only callbacks: feedback thread close/reply and intent verification.

import type { Lang } from '../../../config/constants.ts';
import { t } from '../../../config/constants.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

export function registerAdminRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { feedbackDeps, userRepo, intentDeps } = deps.opts;

  // Feedback: admin closes a thread
  dispatch.set('fb_close', async (ctx, payload, _parts, user) => {
    if (!feedbackDeps) return;
    const lang = (user.language ?? 'en') as Lang;
    if (!feedbackDeps.adminId || user.telegram_id !== feedbackDeps.adminId) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return;
    }
    const threadId = Number(payload);
    const thread = feedbackDeps.feedbackRepo.getThread(threadId);
    if (!thread) {
      await ctx.answer({ text: t(lang).callbackErrors.threadNotFound });
      return;
    }
    feedbackDeps.feedbackRepo.closeThread(threadId);
    await ctx.answer({ text: t(lang).callbackErrors.threadClosed });
    await ctx.editText(`✅ Thread #${threadId} closed`).catch(() => {});
    const threadUser = userRepo?.findByTelegramId(thread.user_id);
    const threadUserLang = (threadUser?.language ?? lang) as Lang;
    feedbackDeps
      .sendMessage(thread.user_id, t(threadUserLang).callbackErrors.feedbackThreadResolved(thread.subject))
      .catch((e: unknown) => {
        cmdLogger.error({ err: e }, 'Failed to notify user of thread close');
      });
  });

  // Feedback: admin initiates a reply
  dispatch.set('fb_reply', async (ctx, payload, _parts, user) => {
    if (!feedbackDeps) return;
    const lang = (user.language ?? 'en') as Lang;
    if (!feedbackDeps.adminId || user.telegram_id !== feedbackDeps.adminId) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return;
    }
    const threadId = Number(payload);
    const thread = feedbackDeps.feedbackRepo.getThread(threadId);
    if (!thread) {
      await ctx.answer({ text: t(lang).callbackErrors.threadNotFound });
      return;
    }
    feedbackDeps.adminReplySession.set(user.telegram_id, {
      threadId,
      userId: thread.user_id,
      chatId: thread.chat_id ?? undefined,
      topicThreadId: thread.topic_thread_id ?? undefined,
    });
    await ctx.answer({ text: t(lang).callbackErrors.sendReplyMessage });
  });

  // Intent verification: accept
  dispatch.set('intent_accept', async (ctx, payload, _parts, user) => {
    if (!intentDeps) return;
    if (intentDeps.intentRepo.isManagedBasis()) {
      await ctx.answer({
        text:
          user.language === 'ru'
            ? 'Интенты управляются единым сидом: изменение через репозиторий.'
            : 'Intents use the source-managed seed. Update the repository.',
      });
      return;
    }
    const intentId = Number(payload);
    const lang = (user.language ?? 'en') as Lang;
    if (!intentDeps.adminId || user.telegram_id !== intentDeps.adminId) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return;
    }
    intentDeps.intentRepo.updateStatus(intentId, 'approved');
    intentDeps.intentMatcher?.reload();
    await ctx.answer(t(lang).callbackErrors.intentApproved);
    const currentText = ctx.message?.text ?? '';
    await ctx.editText(`${currentText}\n\n✅ APPROVED`).catch(() => {});
  });

  // Intent verification: reject
  dispatch.set('intent_reject', async (ctx, payload, _parts, user) => {
    if (!intentDeps) return;
    if (intentDeps.intentRepo.isManagedBasis()) {
      await ctx.answer({
        text:
          user.language === 'ru'
            ? 'Интенты управляются единым сидом: изменение через репозиторий.'
            : 'Intents use the source-managed seed. Update the repository.',
      });
      return;
    }
    const intentId = Number(payload);
    const lang = (user.language ?? 'en') as Lang;
    if (!intentDeps.adminId || user.telegram_id !== intentDeps.adminId) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return;
    }
    intentDeps.intentRepo.updateStatus(intentId, 'rejected');
    await ctx.answer(t(lang).callbackErrors.intentRejected);
    const currentText = ctx.message?.text ?? '';
    await ctx.editText(`${currentText}\n\n❌ REJECTED`).catch(() => {});
  });

  // Intent verification: edit — store admin edit session
  dispatch.set('intent_edit', async (ctx, payload, _parts, user) => {
    if (!intentDeps) return;
    if (intentDeps.intentRepo.isManagedBasis()) {
      await ctx.answer({
        text:
          user.language === 'ru'
            ? 'Интенты управляются единым сидом: изменение через репозиторий.'
            : 'Intents use the source-managed seed. Update the repository.',
      });
      return;
    }
    const intentId = Number(payload);
    const lang = (user.language ?? 'en') as Lang;
    if (!intentDeps.adminId || user.telegram_id !== intentDeps.adminId) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return;
    }
    if (intentDeps.adminEditSessions) {
      intentDeps.adminEditSessions.set(user.telegram_id, {
        intentId,
        state: 'awaiting_instructions',
        createdAt: Date.now(),
      });
    }
    await ctx.answer(t(lang).callbackErrors.sendEditInstructions);
  });
}
