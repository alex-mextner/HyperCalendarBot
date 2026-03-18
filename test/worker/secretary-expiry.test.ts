import { expect, mock, test } from 'bun:test';
import { runSecretaryExpiry } from '../../src/worker/secretary-expiry.ts';

test('expiry: expires pending records then notifies owner with username', async () => {
  const expired = [
    {
      id: 1,
      owner_id: 10,
      secretary_id: 20,
      permission: 'read' as const,
      status: 'pending' as const,
      created_at: '',
      updated_at: '',
      dm_message_id: null,
    },
  ];
  const mockExpirePending = mock(() => expired); // returns records it just expired
  const mockNotify = mock(async () => {});
  const mockFindUser = mock(() => ({ username: 'john_sec', first_name: 'John' }));

  await runSecretaryExpiry({
    secretaryRepo: { expirePending: mockExpirePending } as never,
    userRepo: { findByTelegramId: mockFindUser } as never,
    notify: mockNotify,
  });

  expect(mockExpirePending).toHaveBeenCalled();
  expect(mockNotify).toHaveBeenCalledWith(10, expect.stringContaining('@john_sec'));
  expect(mockNotify).toHaveBeenCalledWith(10, expect.stringContaining('истекло'));
});
