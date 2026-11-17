import { describe, expect, test } from 'bun:test';
import { withTelegramSessionLock } from '../../src/services/telegram-session/session-lock.ts';

type CallerState = { status: 'pending' | 'fulfilled' | 'rejected'; reason: unknown };

describe('personal session waiter cancellation', () => {
  test.each([
    'resolves',
    'throws',
  ] as const)('rejects a queued caller promptly and preserves order when its predecessor %s', async (completion) => {
    const userId = completion === 'resolves' ? 7991101 : 7991102;
    const entered = Promise.withResolvers<void>();
    const predecessorRelease = Promise.withResolvers<void>();
    const followingEntered = Promise.withResolvers<void>();
    const followingRelease = Promise.withResolvers<void>();
    const controller = new AbortController();
    const abortReason = new Error('synthetic request cancellation');
    const predecessorError = new Error('synthetic predecessor failure');
    const cancelled: CallerState = { status: 'pending', reason: undefined };
    const visited: string[] = [];
    const predecessor = withTelegramSessionLock(userId, async () => {
      entered.resolve();
      await predecessorRelease.promise;
      if (completion === 'throws') throw predecessorError;
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const pending: Promise<unknown>[] = [predecessor];

    try {
      await entered.promise;
      pending.push(
        withTelegramSessionLock(
          userId,
          async () => {
            visited.push('cancelled');
          },
          controller.signal,
        ).then(
          () => {
            cancelled.status = 'fulfilled';
          },
          (reason: unknown) => {
            cancelled.status = 'rejected';
            cancelled.reason = reason;
          },
        ),
      );
      const following = withTelegramSessionLock(userId, async () => {
        visited.push('following');
        followingEntered.resolve();
        await followingRelease.promise;
      });
      pending.push(following);
      controller.abort(abortReason);
      const newArrival = withTelegramSessionLock(userId, async () => {
        visited.push('new arrival');
      });
      pending.push(newArrival);

      // Observe the abort handlers while the predecessor remains blocked.
      await Bun.sleep(0);
      expect(cancelled.status).toBe('rejected');
      expect(cancelled.reason).toBe(abortReason);
      expect(visited).toEqual([]);

      predecessorRelease.resolve();
      await followingEntered.promise;
      expect(visited).toEqual(['following']);
      followingRelease.resolve();
      await Promise.all([following, newArrival]);
      expect(visited).toEqual(['following', 'new arrival']);
      expect(await predecessor).toBe(completion === 'throws' ? predecessorError : undefined);
    } finally {
      predecessorRelease.resolve();
      followingRelease.resolve();
      await Promise.allSettled(pending);
    }
  });

  test('keeps an already started operation pending until its acknowledgement arrives', async () => {
    const userId = 7991103;
    const entered = Promise.withResolvers<void>();
    const operationRelease = Promise.withResolvers<void>();
    const controller = new AbortController();
    const acknowledgement = { message_id: 7991103 };
    const caller: CallerState = { status: 'pending', reason: undefined };
    let followingStarted = false;
    const operation = withTelegramSessionLock(
      userId,
      async () => {
        entered.resolve();
        await operationRelease.promise;
        return acknowledgement;
      },
      controller.signal,
    ).then(
      (value) => {
        caller.status = 'fulfilled';
        return value;
      },
      (reason: unknown) => {
        caller.status = 'rejected';
        caller.reason = reason;
        return reason;
      },
    );
    const following = withTelegramSessionLock(userId, async () => {
      followingStarted = true;
    });

    try {
      await entered.promise;
      controller.abort(new Error('synthetic cancellation after dispatch'));
      await Bun.sleep(0);
      expect(caller.status).toBe('pending');
      expect(followingStarted).toBe(false);
      operationRelease.resolve();
      expect(await operation).toBe(acknowledgement);
      expect(caller.status).toBe('fulfilled');
      await following;
      expect(followingStarted).toBe(true);
    } finally {
      operationRelease.resolve();
      await Promise.allSettled([operation, following]);
    }
  });
});
