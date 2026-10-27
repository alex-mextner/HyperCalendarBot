// src/bot/handlers/callback/proposal-routes.ts
// Proposal callbacks: edit proposals, secretary invitations and group calendar proposals.

import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { EditProposal, UpdateEventData, User } from '../../../database/types.ts';
import { type FieldChange, fieldChangesToUpdate } from '../../../services/google/change-detection.ts';
import type { BotCallbackContext } from '../../types.ts';
import {
  handleProposalAccept,
  handleProposalDecline,
  handleSecretaryAccept,
  handleSecretaryDecline,
} from './secretary-proposal-handlers.ts';
import type { CallbackDispatch, CallbackHandlerOpts, CallbackRouteDeps } from './types.ts';

type EditProposalDeps = NonNullable<CallbackHandlerOpts['editProposalDeps']>;

interface ProposalReview {
  ctx: BotCallbackContext;
  user: User;
  lang: Lang;
  proposal: EditProposal;
  proposalDeps: EditProposalDeps;
  eventTitle: string;
}

function parseFieldChanges(proposal: EditProposal): FieldChange[] {
  return JSON.parse(proposal.changes) as FieldChange[];
}

export function registerProposalRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService } = deps;
  const { editProposalDeps, userRepo, secretaryDeps, proposalDeps } = deps.opts;

  /** The pending proposal behind the tap, if the presser owns its event; otherwise answers why not. */
  async function loadOwnedPendingProposal(
    ctx: BotCallbackContext,
    user: User,
    lang: Lang,
    proposalId: number,
    proposals: EditProposalDeps,
  ): Promise<EditProposal | null> {
    const proposal = proposals.editProposalRepo.findById(proposalId);
    if (!proposal) {
      await ctx.answer({ text: t(lang).callbackErrors.proposalNotFound });
      return null;
    }
    if (proposal.status !== 'pending') {
      await ctx.answer({ text: t(lang).callbackErrors.proposalAlreadyProcessed(proposal.status) });
      return null;
    }
    const ownerId = eventService.getEventOwnerId(proposal.event_id);
    if (!ownerId) {
      await ctx.answer({ text: t(lang).callbackErrors.notFound });
      return null;
    }
    if (ownerId !== user.telegram_id) {
      await ctx.answer({ text: t(lang).callbackErrors.notAuthorized });
      return null;
    }
    return proposal;
  }

  function proposerLanguage(proposal: EditProposal, lang: Lang): Lang {
    const proposerUser = userRepo?.findByTelegramId(proposal.proposer_id);
    return (proposerUser?.language ?? lang) as Lang;
  }

  async function acceptEditProposal(review: ProposalReview): Promise<void> {
    const { ctx, user, lang, proposal, proposalDeps: proposals, eventTitle } = review;
    const isGoogleSync = proposal.source === 'google_sync';
    const changesForDisplay = isGoogleSync ? parseFieldChanges(proposal) : [];
    const updateData = isGoogleSync
      ? fieldChangesToUpdate(changesForDisplay)
      : (JSON.parse(proposal.changes) as UpdateEventData);

    proposals.editProposalRepo.updateStatus(proposal.id, 'accepted');
    const updated = eventService.updateEvent(proposal.event_id, user.telegram_id, updateData, {
      source: 'proposal_accept',
      skipProposalExpiry: true,
      excludeUserIds: [proposal.proposer_id],
    });
    await ctx.answer();
    await ctx.editText(
      updated ? t(lang).callbackErrors.proposalAccepted(updated.title) : t(lang).callbackErrors.proposalAcceptedNoEvent,
    );

    const proposerLang = proposerLanguage(proposal, lang);
    if (changesForDisplay.length > 0) {
      const { formatChanges } = await import('../../../services/google/change-detection.ts');
      const diffText = formatChanges(changesForDisplay, proposerLang);
      proposals
        .sendMessage(proposal.proposer_id, t(proposerLang).sync.proposalAccepted(eventTitle, diffText))
        .catch(() => {});
    } else {
      proposals
        .sendMessage(proposal.proposer_id, t(proposerLang).callbackErrors.proposalAcceptedNotification(eventTitle))
        .catch(() => {});
    }
  }

  async function rejectEditProposal(review: ProposalReview): Promise<void> {
    const { ctx, lang, proposal, proposalDeps: proposals, eventTitle } = review;
    const isGoogleSync = proposal.source === 'google_sync';
    proposals.editProposalRepo.updateStatus(proposal.id, 'rejected');
    await ctx.answer();
    await ctx.editText(t(lang).callbackErrors.proposalRejected);

    if (isGoogleSync && proposals.enqueueSyncJob) {
      proposals
        .enqueueSyncJob({
          type: 'push-participant-event',
          userId: proposal.proposer_id,
          eventId: proposal.event_id,
          action: 'update',
        })
        .catch(() => {});
    }

    const proposerLang = proposerLanguage(proposal, lang);
    if (isGoogleSync) {
      const { formatChanges } = await import('../../../services/google/change-detection.ts');
      const diffText = formatChanges(parseFieldChanges(proposal), proposerLang);
      proposals
        .sendMessage(proposal.proposer_id, t(proposerLang).sync.proposalRejected(eventTitle, diffText))
        .catch(() => {});
    } else {
      proposals
        .sendMessage(proposal.proposer_id, t(proposerLang).callbackErrors.proposalRejectedNotification(eventTitle))
        .catch(() => {});
    }
  }

  // Edit proposal accept/reject
  dispatch.set(CB.EDIT_PROPOSAL, async (ctx, _payload, parts, user) => {
    if (!editProposalDeps) return;
    const subAction = parts[1];
    const lang = (user.language ?? 'en') as Lang;
    const proposal = await loadOwnedPendingProposal(ctx, user, lang, Number(parts[2]), editProposalDeps);
    if (!proposal) return;

    // Resolve the event title up front — bypass soft-delete so the
    // proposer's notification always shows which event their proposal
    // referenced, even if the owner has since removed it. The lookup
    // still enforces ownership via the user.telegram_id check, so this
    // is not an IDOR (we already verified `ownerId === user.telegram_id`).
    const eventForTitle = eventService.getEventIncludingSoftDeleted(proposal.event_id, user.telegram_id);
    const eventTitle = eventForTitle?.title ?? `#${proposal.event_id}`;
    const review: ProposalReview = { ctx, user, lang, proposal, proposalDeps: editProposalDeps, eventTitle };

    if (subAction === 'accept') {
      await acceptEditProposal(review);
    } else if (subAction === 'reject') {
      await rejectEditProposal(review);
    }
  });

  // Secretary accept/decline
  dispatch.set('sec', async (ctx, _payload, _parts, user, data) => {
    if (!secretaryDeps) return;
    if (data.startsWith('sec:accept:')) {
      const id = Number(data.slice('sec:accept:'.length));
      await handleSecretaryAccept(id, user.telegram_id, secretaryDeps);
      await ctx.answer();
      return;
    }
    if (data.startsWith('sec:decline:')) {
      const id = Number(data.slice('sec:decline:'.length));
      await handleSecretaryDecline(id, user.telegram_id, secretaryDeps);
      await ctx.answer();
    }
  });

  // Group proposal accept/decline
  dispatch.set('prop', async (ctx, _payload, _parts, user, data) => {
    if (data.startsWith('prop:accept:') && proposalDeps) {
      const id = Number(data.slice('prop:accept:'.length));
      await handleProposalAccept(id, user.telegram_id, proposalDeps);
      await ctx.answer();
      return;
    }
    if (data.startsWith('prop:decline:') && proposalDeps) {
      const id = Number(data.slice('prop:decline:'.length));
      await handleProposalDecline(id, user.telegram_id, proposalDeps);
      await ctx.answer();
    }
  });
}
