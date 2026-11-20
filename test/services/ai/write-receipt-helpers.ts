/**
 * Shared fixtures of the write-receipt suites: synthetic ids (secretary 1001, calendar owner 2002,
 * invitees 3001/3002), recorded tool results and the secretary context every receipt is built from.
 */
import { CalendarProposalRepository } from '../../../src/database/repositories/calendar-proposal.repository.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import type { ToolRunLedger } from '../../../src/services/ai/agent/tool-round.ts';
import { planGuard } from '../../../src/services/ai/agent/turn-finish.ts';
import { createTurnState } from '../../../src/services/ai/agent/turn-state.ts';
import { WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext, ToolResult } from '../../../src/services/ai/types.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { receiptView } from '../../../src/services/ai/write-receipt.ts';
import { createAgentRunFixture } from './agent-run-helpers.ts';

export const SECRETARY = 1001;
export const OWNER = 2002;
export const FRIEND = 3001;
export const STRANGER = 3002;

export type Recorded = ToolResult & { disposition: 'executed' | 'failed' | 'skipped' };

export const created: Recorded = {
  success: true,
  disposition: 'executed',
  mutationState: 'confirmed',
  data: { id: 501, title: 'Board games', date: '2026-10-31', time: '17:00', all_day: false },
};
export const eventNotFound: Recorded = {
  success: false,
  disposition: 'failed',
  mutationState: 'not_applied',
  error: 'Event not found',
};
export const rejectedCreate: Recorded = {
  success: false,
  disposition: 'failed',
  mutationState: 'not_applied',
  error: 'bad end_at',
};
export const exec = (extra: Partial<Recorded> = {}): Recorded => ({
  success: true,
  disposition: 'executed',
  mutationState: 'confirmed',
  ...extra,
});
export const okCall = exec({ data: { id: 601, title: 'Call', date: '2026-10-31', time: '10:00', all_day: false } });
export const uncertain: Recorded = {
  success: false,
  disposition: 'failed',
  mutationState: 'uncertain',
  error: 'timeout',
};
export const createInput = {
  title: 'Board games',
  start_at: '2026-10-31T17:00:00Z',
  end_at: '2026-10-31T18:00:00Z',
  owner_id: OWNER,
  scope: 'personal',
};

function ledgerWith(writeOutcomes: WriteOutcomes): ToolRunLedger {
  return { allToolCalls: [], allToolResults: [], toolEvidence: [], seenToolCallKeys: new Set(), writeOutcomes };
}

interface Names {
  owner?: string | null;
  friend?: string;
  /** The delegation the secretary holds: active (default), revoked, or never granted. */
  access?: 'revoked' | 'none';
}

/** A secretary (1001) whose active write access covers the owner's calendar (2002, "Olga"). */
export function secretaryContext(language: 'ru' | 'en', isGroup = false, names: Names = {}): AgentContext {
  const { db, ctx } = createAgentRunFixture();
  ctx.userRepo.create({ telegram_id: SECRETARY, first_name: 'Kim', timezone: 'UTC', language });
  ctx.userRepo.create({
    telegram_id: OWNER,
    first_name: names.owner === undefined ? 'Olga' : (names.owner ?? undefined),
    timezone: 'UTC',
    language,
  });
  const contactRepo = new ContactRepository(db);
  contactRepo.upsert(SECRETARY, names.friend ?? 'Friend', undefined, FRIEND);
  const secretaryRepo = new SecretaryRepository(db);
  if (names.access !== 'none') {
    const record = secretaryRepo.upsert({ owner_id: OWNER, secretary_id: SECRETARY, permission: 'write' });
    secretaryRepo.updateStatus(record.id, names.access === 'revoked' ? 'revoked' : 'active');
  }
  const user = ctx.userRepo.findByTelegramId(SECRETARY);
  if (!user) throw new Error('secretary was not created');
  return {
    ...ctx,
    user,
    contactRepo,
    isGroup,
    secretary: { secretaryRepo, secretaryForLine: undefined, calendarProposalRepo: new CalendarProposalRepository(db) },
  };
}

export function receipt(ledger: WriteOutcomes, ctx: AgentContext) {
  const state = createTurnState();
  state.termination = 'normal';
  return planGuard(ctx, state, false, ledgerWith(ledger));
}

/** The incident: one create in the owner's calendar, then three invitations the account cannot see. */
export function incident(): WriteOutcomes {
  const ledger = new WriteOutcomes(WRITE_TOOLS);
  ledger.record('create_event', createInput, created);
  ledger.record('send_invitation', { event_id: 501, invitee_username: 'sam_demo' }, eventNotFound);
  ledger.record('send_invitation', { event_id: 501, invitee_id: FRIEND }, eventNotFound);
  ledger.record('send_invitation', { event_id: 501, invitee_id: STRANGER }, eventNotFound);
  return ledger;
}

export function receiptViewFor(language: 'ru' | 'en') {
  return receiptView(secretaryContext(language));
}
