// src/bot/handlers/callback/secretary-proposal-handlers.ts
// Secretary-invitation and group-proposal accept/decline actions, independent of the callback router.

import { z } from 'zod';
import { jsonCodec } from '../../../utils/json-codec.ts';
import type { ProposalDeps, SecretaryDeps } from './types.ts';

function formatUserRef(user: { first_name?: string | null; username?: string | null; telegram_id: number }): string {
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return `User ${user.telegram_id}`;
}

export async function handleSecretaryAccept(id: number, callerId: number, deps: SecretaryDeps): Promise<void> {
  const record = deps.secretaryRepo.findById(id);
  if (!record || record.secretary_id !== callerId || record.status !== 'pending') return;

  deps.secretaryRepo.updateStatus(id, 'active');

  const secretary = deps.userRepo.findByTelegramId(record.secretary_id);
  const secretaryRef = secretary ? formatUserRef(secretary) : `User ${record.secretary_id}`;
  await deps.sendMessage(
    record.owner_id,
    `Пользователь ${secretaryRef} принял приглашение и теперь является секретарём твоего календаря.`,
  );

  if (record.dm_message_id !== null) {
    const owner = deps.userRepo.findByTelegramId(record.owner_id);
    const ownerRef = owner ? formatUserRef(owner) : `User ${record.owner_id}`;
    await deps.editMessage(
      record.secretary_id,
      record.dm_message_id,
      `✅ Принято. Ты теперь секретарь ${ownerRef}. Напиши мне, чтобы управлять её/его календарём.`,
    );
  }
}

export async function handleSecretaryDecline(id: number, callerId: number, deps: SecretaryDeps): Promise<void> {
  const record = deps.secretaryRepo.findById(id);
  if (!record || record.secretary_id !== callerId || record.status !== 'pending') return;

  deps.secretaryRepo.updateStatus(id, 'declined');

  const secretary = deps.userRepo.findByTelegramId(record.secretary_id);
  const secretaryRef = secretary ? formatUserRef(secretary) : `User ${record.secretary_id}`;
  await deps.sendMessage(record.owner_id, `${secretaryRef} отклонил приглашение секретаря.`);

  if (record.dm_message_id !== null) {
    await deps.editMessage(record.secretary_id, record.dm_message_id, 'Приглашение отклонено.');
  }
}

const ProposalPayloadSchema = z.object({
  action: z.string(),
  event: z
    .object({
      title: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      start_at: z.string(),
      end_at: z.string().optional(),
      all_day: z.boolean().optional(),
      timezone: z.string(),
      location: z.string().optional(),
      recurrence_rule: z.string().optional(),
      recurrence_end_at: z.string().optional(),
      reminder_minutes: z.array(z.number()).optional(),
      owner_type: z.enum(['user', 'group']).optional(),
      group_id: z.number().optional(),
      created_by: z.number().optional(),
      event_type: z.literal('birthday').optional(),
    })
    .optional(),
  event_id: z.number().optional(),
  changes: z
    .object({
      title: z.string().optional(),
      description: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      start_at: z.string().optional(),
      end_at: z.string().nullable().optional(),
      all_day: z.boolean().optional(),
      timezone: z.string().optional(),
      location: z.string().nullable().optional(),
      recurrence_rule: z.string().nullable().optional(),
      recurrence_end_at: z.string().nullable().optional(),
      reminder_overrides: z.string().nullable().optional(),
      google_calendar_id: z.string().nullable().optional(),
      google_event_id: z.string().nullable().optional(),
      google_etag: z.string().nullable().optional(),
      sync_status: z
        .enum(['local_only', 'synced', 'pending_push', 'pending_pull', 'conflict', 'push_failed'])
        .optional(),
      sync_version: z.number().optional(),
      last_synced_at: z.string().nullable().optional(),
    })
    .optional(),
});
type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;
type PendingProposal = NonNullable<ReturnType<ProposalDeps['proposalRepo']['findById']>>;

function userRefById(telegramId: number, deps: Pick<ProposalDeps, 'userRepo'>): string {
  const user = deps.userRepo.findByTelegramId(telegramId);
  return user ? formatUserRef(user) : `User ${telegramId}`;
}

/** Runs the proposed create/update/delete; a falsy result means the target event is gone. */
function applyProposal(
  proposal: PendingProposal,
  payload: ProposalPayload,
  deps: ProposalDeps,
): { id: number; title?: string } | boolean | null | undefined {
  if (proposal.action === 'create' && payload.event) {
    return deps.eventService.createEvent(proposal.target_id, payload.event);
  }
  if (proposal.action === 'update' && payload.event_id !== undefined && payload.changes) {
    return deps.eventService.updateEvent(payload.event_id, proposal.target_id, payload.changes);
  }
  if (proposal.action === 'delete' && payload.event_id !== undefined) {
    return deps.eventService.deleteEvent(payload.event_id, proposal.target_id);
  }
  return undefined;
}

export async function handleProposalAccept(id: number, callerId: number, deps: ProposalDeps): Promise<void> {
  const proposal = deps.proposalRepo.findById(id);
  if (!proposal || proposal.target_id !== callerId) return;

  if (proposal.status !== 'pending') {
    if (proposal.dm_message_id !== null) {
      await deps.editMessage(proposal.target_id, proposal.dm_message_id, 'Предложение истекло или уже обработано.');
    }
    return;
  }

  const payloadData = jsonCodec(ProposalPayloadSchema).parse(proposal.payload);

  const result = applyProposal(proposal, payloadData, deps);

  if (result === null || result === undefined || result === false) {
    deps.proposalRepo.updateStatus(id, 'expired');
    await deps.sendMessage(proposal.target_id, 'Событие больше не существует — предложение аннулировано.');
    await deps.sendMessage(proposal.proposer_id, 'Событие больше не существует — предложение аннулировано.');
    return;
  }

  const proposerRef = userRefById(proposal.proposer_id, deps);
  const targetRef = userRefById(proposal.target_id, deps);

  if (proposal.dm_message_id !== null) {
    await deps.editMessage(
      proposal.target_id,
      proposal.dm_message_id,
      '✅ Принято. Изменение применено к твоему календарю.',
    );
  }

  if (proposal.group_message_id !== null) {
    await deps.editMessage(
      proposal.group_chat_id,
      proposal.group_message_id,
      `✅ ${targetRef} принял(а) предложение от ${proposerRef}: ${proposal.summary}`,
    );
  }

  deps.proposalRepo.updateStatus(id, 'accepted');
  await deps.sendMessage(proposal.proposer_id, `✅ ${targetRef} принял(а) твоё предложение: ${proposal.summary}`);
}

export async function handleProposalDecline(id: number, callerId: number, deps: ProposalDeps): Promise<void> {
  const proposal = deps.proposalRepo.findById(id);
  if (!proposal || proposal.target_id !== callerId) return;

  deps.proposalRepo.updateStatus(id, 'declined');

  const proposerRef = userRefById(proposal.proposer_id, deps);
  const targetRef = userRefById(proposal.target_id, deps);

  if (proposal.dm_message_id !== null) {
    await deps.editMessage(proposal.target_id, proposal.dm_message_id, 'Предложение отклонено.');
  }

  if (proposal.group_message_id !== null) {
    await deps.editMessage(
      proposal.group_chat_id,
      proposal.group_message_id,
      `❌ ${targetRef} отклонил(а) предложение от ${proposerRef}: ${proposal.summary}`,
    );
  }

  await deps.sendMessage(proposal.proposer_id, `❌ ${targetRef} отклонил(а) твоё предложение: ${proposal.summary}`);
}
