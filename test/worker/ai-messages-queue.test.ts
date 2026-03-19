import { describe, expect, mock, test } from 'bun:test';
import type { User } from '../../src/database/types.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { SyntheticPipelineRunner } from '../../src/worker/ai-messages-queue.ts';

const fakeUser: User = {
  telegram_id: 1,
  language: 'en',
  timezone: 'UTC',
  username: null,
  first_name: null,
  country_code: null,
  google_refresh_token_enc: null,
  google_calendar_id: null,
  onboarding_completed: 1,
  timezone_updated_at: null,
  voice_response_enabled: null,
  default_event_duration_minutes: 60,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
} as User;

describe('SyntheticPipelineRunner', () => {
  test('runs intent path when intent matches', async () => {
    const agentCtx = {
      user: fakeUser,
      sender: { sendMessage: mock(async () => ({ message_id: 1 })) },
    } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: true, response: 'ok' }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, 'test message');

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).not.toHaveBeenCalled();
  });

  test('falls through to AI agent when no intent matches', async () => {
    const agentCtx = { user: fakeUser } as unknown as AgentContext;
    const contextBuilder = mock(() => agentCtx);
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    await runner.run(fakeUser, 'test message');

    expect(intentRun).toHaveBeenCalledTimes(1);
    expect(agentRun).toHaveBeenCalledTimes(1);
  });

  test('catches errors and does not rethrow', async () => {
    const contextBuilder = mock(() => {
      throw new Error('context build failed');
    });
    const intentRun = mock(async () => ({ handled: false }));
    const agentRun = mock(async () => {});

    const runner = new SyntheticPipelineRunner({ contextBuilder, intentRun, agentRun });
    // Must not throw
    await expect(runner.run(fakeUser, 'test')).resolves.toBeUndefined();
  });
});
