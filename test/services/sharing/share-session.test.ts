import { describe, expect, mock, test } from 'bun:test';
import { ShareSessionManager } from '../../../src/services/sharing/share-session';

describe('ShareSessionManager', () => {
  type RedisLike = ConstructorParameters<typeof ShareSessionManager>[0];

  test('create stores session and returns ID', async () => {
    const redis = {
      set: mock(() => Promise.resolve('OK')),
      get: mock(() => Promise.resolve(null)),
      del: mock(() => Promise.resolve(1)),
    } as Partial<RedisLike> as RedisLike;
    const manager = new ShareSessionManager(redis);
    const id = await manager.create({
      userId: 100,
      targetType: 'user',
      targetId: 200,
      contentType: 'agenda',
      period: 'today',
    });
    expect(id).toBeTruthy();
    expect(redis.set).toHaveBeenCalled();
    const setArgs = (redis.set as ReturnType<typeof mock>).mock.calls[0]!;
    expect(setArgs[2]).toEqual({ ex: 300 });
  });

  test('resolve returns session data', async () => {
    const sessionData = JSON.stringify({
      userId: 100,
      targetType: 'user',
      targetId: 200,
      contentType: 'agenda',
      period: 'today',
    });
    const redis = {
      get: mock(() => Promise.resolve(sessionData)),
      del: mock(() => Promise.resolve(1)),
    } as Partial<RedisLike> as RedisLike;
    const manager = new ShareSessionManager(redis);
    const session = await manager.resolve('sess_abc');
    expect(session).not.toBeNull();
    expect(session!.userId).toBe(100);
  });

  test('resolve returns null for expired session', async () => {
    const redis = { get: mock(() => Promise.resolve(null)) } as Partial<RedisLike> as RedisLike;
    const manager = new ShareSessionManager(redis);
    expect(await manager.resolve('sess_gone')).toBeNull();
  });

  test('consume deletes session after resolve', async () => {
    const sessionData = JSON.stringify({
      userId: 100,
      targetType: 'user',
      targetId: 200,
      contentType: 'agenda',
    });
    const redis = {
      get: mock(() => Promise.resolve(sessionData)),
      del: mock(() => Promise.resolve(1)),
    } as Partial<RedisLike> as RedisLike;
    const manager = new ShareSessionManager(redis);
    await manager.consume('sess_abc');
    expect(redis.del).toHaveBeenCalledWith('share_session:sess_abc');
  });
});
