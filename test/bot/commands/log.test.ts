// Command behavior uses a fake context and repository; no Telegram or database access.
import { expect, mock, test } from 'bun:test';
import { handleLog } from '../../../src/bot/commands/log.ts';
import type { ActionLogRepository } from '../../../src/database/repositories/action-log.repository.ts';
import type { UserActionLog } from '../../../src/database/types.ts';

function fixture(args = '', entries: UserActionLog[] = []) {
  const send = mock(async (_text: string, _options?: { parse_mode: 'HTML' }) => {});
  const ctx: Parameters<typeof handleLog>[0] = { dbUser: { telegram_id: 42 }, args, send };
  const repo = { query: mock(() => entries), getRecent: mock(() => entries), getByEvent: mock(() => entries) } as Pick<
    ActionLogRepository,
    'query' | 'getRecent' | 'getByEvent'
  >;
  return { ctx, send, repo };
}

test('invalid user and limit arguments must not reach the repository', async () => {
  for (const args of ['bad', '12junk', '42 bad', '42 0', '42 -1', '42 1.5']) {
    const f = fixture(args);
    await handleLog(f.ctx, f.repo, 42);
    expect(f.repo.query).not.toHaveBeenCalled();
    expect(f.repo.getRecent).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith('Usage: /log [user_id] [limit] or /log event:ID');
  }
});

test('authorization rejects non-admins and ignores unresolved users', async () => {
  const f = fixture();
  await handleLog(f.ctx, f.repo, 1);
  expect(f.send).toHaveBeenCalledWith('Admin only.');
  f.ctx.dbUser = undefined;
  f.send.mockClear();
  await handleLog(f.ctx, f.repo, 42);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.repo.query).not.toHaveBeenCalled();
});

test('default, user and event filters call the correct repository with limits', async () => {
  for (const args of ['', '17 50', 'event:9']) {
    const f = fixture(args);
    await handleLog(f.ctx, f.repo, 42);
    if (!args) {
      expect(f.repo.query).toHaveBeenCalledWith({ limit: 20 });
      expect(f.send).toHaveBeenCalledWith('Recent action log: no entries.');
    } else if (args.startsWith('event')) {
      expect(f.repo.getByEvent).toHaveBeenCalledWith(9, 50);
      expect(f.send).toHaveBeenCalledWith('Action log for event #9: no entries.');
    } else {
      expect(f.repo.getRecent).toHaveBeenCalledWith(17, 50);
      expect(f.send).toHaveBeenCalledWith('Action log for user 17: no entries.');
    }
  }
  const f = fixture('event:bad');
  await handleLog(f.ctx, f.repo, 42);
  expect(f.send).toHaveBeenCalledWith('Invalid event ID.');
  expect(f.repo.getByEvent).not.toHaveBeenCalled();
});

test('log renders success, failure, truncated input, event and message link', async () => {
  const entry: UserActionLog = {
    id: 1,
    user_id: 17,
    chat_id: -100123,
    message_id: 6,
    chat_history_id: null,
    action_type: 'command',
    action_name: 'add',
    input_summary: 'x'.repeat(150),
    result_summary: null,
    metadata: null,
    target_event_id: 9,
    target_user_id: null,
    success: 1,
    created_at: '2026-09-13T12:00:00Z',
  };
  const f = fixture('', [
    entry,
    { ...entry, id: 2, success: 0, input_summary: null, target_event_id: null, message_id: null },
  ]);
  await handleLog(f.ctx, f.repo, 42);
  const text = f.send.mock.calls[0]![0];
  expect(text).toContain('✓ command:add (user:17)');
  expect(text).toContain('✗ command:add (user:17)');
  expect(text).toContain('event: #9');
  expect(text).toContain('https://t.me/c/123/6');
  expect(text).toContain('x'.repeat(100));
  expect(text).not.toContain('x'.repeat(101));
  expect(f.send.mock.calls[0]![1]).toEqual({ parse_mode: 'HTML' });
});
