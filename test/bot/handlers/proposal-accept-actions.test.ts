// Pins which event-service call each proposal action maps to, and that an action whose payload is
// incomplete (nothing to apply) is treated like a vanished event instead of being accepted.

import { describe, expect, mock, test } from 'bun:test';
import { handleProposalAccept } from '../../../src/bot/handlers/callback.handler';
import type { CalendarProposal, ProposalAction } from '../../../src/database/types.ts';
import { makeUserRow } from '../telegram-fixtures.ts';

function proposal(action: ProposalAction, payload: object): CalendarProposal {
  return {
    id: 10,
    group_chat_id: -100,
    group_chat_title: 'Team',
    proposer_id: 1,
    target_id: 2,
    action,
    payload: JSON.stringify({ action, ...payload }),
    summary: 'summary',
    status: 'pending',
    group_message_id: null,
    dm_message_id: null,
    expires_at: '2999-01-01 00:00:00',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
}

function makeDeps(record: CalendarProposal) {
  return {
    proposalRepo: { findById: mock(() => record), updateStatus: mock(() => true) },
    eventService: {
      createEvent: mock(() => ({ id: 99 })),
      updateEvent: mock(() => ({ id: 5 })),
      deleteEvent: mock(() => true),
    },
    userRepo: { findByTelegramId: mock(() => makeUserRow({ first_name: 'Alice', username: 'alice', telegram_id: 1 })) },
    editMessage: mock(async () => {}),
    sendMessage: mock(async () => {}),
  };
}

describe('handleProposalAccept action mapping', () => {
  test('update applies the changes to the stored event id as the target user', async () => {
    const deps = makeDeps(proposal('update', { event_id: 5, changes: { title: 'New title' } }));
    await handleProposalAccept(10, 2, deps);

    expect(deps.eventService.updateEvent).toHaveBeenCalledWith(5, 2, { title: 'New title' });
    expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'accepted');
  });

  test('delete removes the stored event id as the target user', async () => {
    const deps = makeDeps(proposal('delete', { event_id: 5 }));
    await handleProposalAccept(10, 2, deps);

    expect(deps.eventService.deleteEvent).toHaveBeenCalledWith(5, 2);
    expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'accepted');
  });

  test('delete of an event id 0 is still applied (a falsy id is not a missing id)', async () => {
    const deps = makeDeps(proposal('delete', { event_id: 0 }));
    await handleProposalAccept(10, 2, deps);

    expect(deps.eventService.deleteEvent).toHaveBeenCalledWith(0, 2);
  });

  test('an update without changes applies nothing and expires the proposal', async () => {
    const deps = makeDeps(proposal('update', { event_id: 5 }));
    await handleProposalAccept(10, 2, deps);

    expect(deps.eventService.updateEvent).not.toHaveBeenCalled();
    expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'expired');
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
  });

  test('a delete whose event is already gone expires the proposal', async () => {
    const deps = makeDeps(proposal('delete', { event_id: 5 }));
    deps.eventService.deleteEvent = mock(() => false);
    await handleProposalAccept(10, 2, deps);

    expect(deps.proposalRepo.updateStatus).toHaveBeenCalledWith(10, 'expired');
  });
});
