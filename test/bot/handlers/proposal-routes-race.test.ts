// An edit proposal is settled by exactly one tap: Accept and Reject pressed in the same event-loop turn must
// not both act on it (Accept applying the change and Reject then overwriting the status and notifying).

import { expect, mock, test } from 'bun:test';
import { registerProposalRoutes } from '../../../src/bot/handlers/callback/proposal-routes';
import type { CallbackDispatch, CallbackRouteDeps } from '../../../src/bot/handlers/callback/types';
import type { BotCallbackContext } from '../../../src/bot/types.ts';
import { CB } from '../../../src/config/constants';
import type { EditProposal, EditProposalStatus } from '../../../src/database/types.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';
import { stub } from '../partial-stub.ts';
import { makeUserRow, sentMessage } from '../telegram-fixtures.ts';

const OWNER = makeUserRow({ telegram_id: 100, language: 'en' });

function makeProposal(status: EditProposalStatus): EditProposal {
  return {
    id: 7,
    event_id: 3,
    proposer_id: 200,
    changes: JSON.stringify({ title: 'New' }),
    reason: null,
    status,
    created_at: '2026-10-28T00:00:00Z',
    expires_at: null,
    original_values: null,
    source: 'user',
    organizer_message_id: null,
    organizer_chat_id: null,
    participant_message_id: null,
    participant_chat_id: null,
  };
}

function makeCtx(data: string) {
  return stub<BotCallbackContext>({
    data,
    answer: mock<BotCallbackContext['answer']>(() => Promise.resolve(true as const)),
    editText: mock(() => Promise.resolve(sentMessage())),
  });
}

test('Accept and Reject tapped in the same turn: only the first settles the proposal', async () => {
  let stored = makeProposal('pending');
  const updateStatus = mock((_id: number, status: EditProposalStatus) => {
    stored = { ...stored, status };
  });
  const updateEvent = mock(() => null);
  const sendMessage = mock(() => Promise.resolve());
  const dispatch: CallbackDispatch = new Map();
  const deps: CallbackRouteDeps = {
    eventService: stub<EventService>({
      getEventOwnerId: () => OWNER.telegram_id,
      getEventIncludingSoftDeleted: () => null,
      updateEvent,
    }),
    editValueScene: stub({}),
    holidayService: stub({}),
    prefsService: stub({}),
    opts: {
      editProposalDeps: {
        editProposalRepo: stub({ findById: () => stored, updateStatus }),
        sendMessage,
      },
    },
  };
  registerProposalRoutes(dispatch, deps);
  const handler = dispatch.get(CB.EDIT_PROPOSAL);
  if (!handler) throw new Error('edit proposal route is not registered');

  const accept = makeCtx(`${CB.EDIT_PROPOSAL}:accept:7`);
  const reject = makeCtx(`${CB.EDIT_PROPOSAL}:reject:7`);
  await Promise.all([
    handler(accept, '', [CB.EDIT_PROPOSAL, 'accept', '7'], OWNER, accept.data ?? ''),
    handler(reject, '', [CB.EDIT_PROPOSAL, 'reject', '7'], OWNER, reject.data ?? ''),
  ]);

  expect(updateStatus).toHaveBeenCalledTimes(1);
  expect(updateStatus).toHaveBeenCalledWith(7, 'accepted');
  expect(stored.status).toBe('accepted');
  expect(updateEvent).toHaveBeenCalledTimes(1);
  expect(sendMessage).not.toHaveBeenCalledWith(200, expect.stringMatching(/reject/i));
  expect(reject.editText).not.toHaveBeenCalled();
});
