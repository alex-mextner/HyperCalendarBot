import { expect, mock, test } from 'bun:test';
import { runProposalExpiry } from '../../src/worker/proposal-expiry.ts';

test('expiry: edits DM and group message for each expired proposal', async () => {
  const expired = [
    {
      id: 1,
      proposer_id: 10,
      target_id: 20,
      group_chat_id: -100,
      group_message_id: 500,
      dm_message_id: 600,
      summary: 'add meeting',
      status: 'expired',
      action: 'create',
      payload: '{}',
      expires_at: '',
      created_at: '',
      updated_at: '',
      group_chat_title: 'Dev Team',
    },
  ];
  const mockExpirePending = mock(() => expired);
  const mockEditMsg = mock(async () => {});

  await runProposalExpiry({
    proposalRepo: { expirePending: mockExpirePending } as never,
    editMessage: mockEditMsg,
  });

  expect(mockExpirePending).toHaveBeenCalled();
  expect(mockEditMsg).toHaveBeenCalledTimes(2); // DM (target_id=20) + group (group_chat_id=-100)
});

test('expiry: skips DM edit if dm_message_id is null', async () => {
  const expired = [
    {
      id: 2,
      target_id: 20,
      group_chat_id: -100,
      group_message_id: 500,
      dm_message_id: null,
      status: 'expired',
      action: 'create',
      payload: '{}',
      expires_at: '',
      created_at: '',
      updated_at: '',
    },
  ];
  const mockEditMsg = mock(async () => {});

  await runProposalExpiry({
    proposalRepo: { expirePending: mock(() => expired) } as never,
    editMessage: mockEditMsg,
  });

  expect(mockEditMsg).toHaveBeenCalledTimes(1); // only group
});
