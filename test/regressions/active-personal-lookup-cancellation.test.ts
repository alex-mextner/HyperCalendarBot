import { expect, mock, spyOn, test } from 'bun:test';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { handleFindUser } from '../../src/services/ai/tool-handlers/meta.ts';
import { encryptBlob } from '../../src/services/crypto/session-crypto.ts';
import { SessionBridge } from '../../src/services/telegram-session/session-bridge.ts';
import { withTelegramSessionLock } from '../../src/services/telegram-session/session-lock.ts';
import { createAgentRunFixture, USER_ID } from '../services/ai/agent-run-helpers.ts';

const MASTER_KEY = Buffer.alloc(32, 0x58);
const STALLED_CHILD = `
  process.on('SIGTERM', () => {});
  process.stdout.write('partial lookup output');
  process.stderr.write('synthetic stalled lookup');
  process.send('lookup-ready');
  setInterval(() => {}, 1000);
`;

async function within<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

test('an active read-only lookup reaps its child before cleanup and the next owner operation', async () => {
  const { db, ctx, sender } = createAgentRunFixture();
  const sessions = new TelegramSessionRepository(db);
  const encrypted = encryptBlob(Buffer.from('synthetic active lookup credential'), MASTER_KEY);
  sessions.upsert(USER_ID, encrypted, '+***00', 'synthetic-owner');
  const expire = spyOn(sessions, 'expireIfCurrent');
  const controller = new AbortController();
  const reason = new DOMException('Synthetic lookup cancelled', 'AbortError');
  const reconnect = mock(async () => ({ message_id: 900 }));
  ctx.telegramSessionRepo = sessions;
  ctx.telegramMasterKey = MASTER_KEY;
  ctx.requestSignal = controller.signal;
  ctx.messageText = 'Find @synthetic_lookup';
  ctx.sender = { ...sender, sendMessageWithKeyboard: reconnect };

  const realSpawn = Bun.spawn.bind(Bun);
  const realCleanup = SessionBridge.cleanupTempFile;
  const ready = Promise.withResolvers<void>();
  const events: string[] = [];
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let exited = false;
  let sessionPath = '';
  let cleanupSawExit = false;
  let nextSawExit = false;
  let nextSawLivePid = true;
  let nextStarted = false;
  let lookup: Promise<unknown> | undefined;
  let next: Promise<void> | undefined;
  const cleanup = spyOn(SessionBridge, 'cleanupTempFile').mockImplementation(async (path) => {
    events.push('cleanup');
    cleanupSawExit = exited && child !== undefined && !isAlive(child.pid);
    await realCleanup(path);
  });
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((
    command: string[],
    options: {
      stdout: 'pipe';
      stderr: 'pipe';
      signal?: AbortSignal;
      killSignal?: string | number;
    },
  ) => {
    // Keep the real bridge and stdio lifecycle; replace only its executable with a harmless child.
    expect(command.slice(0, 3)).toEqual(['venv/bin/python', 'scripts/connect-session.py', 'resolve_username']);
    expect(options.stdout).toBe('pipe');
    expect(options.stderr).toBe('pipe');
    sessionPath = command[command.indexOf('--session_path') + 1]!;
    child = realSpawn([process.execPath, '--eval', STALLED_CHILD], {
      ...options,
      stdin: 'ignore',
      ipc(message) {
        if (message === 'lookup-ready') ready.resolve();
      },
    });
    void child.exited.then(() => {
      exited = true;
      events.push('exited');
    });
    return child;
  }) as unknown as typeof Bun.spawn);

  try {
    lookup = handleFindUser(ctx, { username: 'synthetic_lookup' });
    const observed = lookup.then(
      (result) => ({ kind: 'resolved', result }),
      (error: unknown) => ({ kind: 'rejected', error }),
    );
    await within(ready.promise, 'Synthetic lookup child did not start');
    expect(child?.exitCode).toBeNull();
    expect(await Bun.file(sessionPath).exists()).toBe(true);
    next = withTelegramSessionLock(USER_ID, async () => {
      nextStarted = true;
      events.push('next');
      nextSawExit = exited;
      nextSawLivePid = child ? isAlive(child.pid) : true;
    });
    await Promise.resolve();
    expect(nextStarted).toBe(false);

    controller.abort(reason);
    expect(await within(observed, 'Active lookup ignored request cancellation')).toEqual({
      kind: 'rejected',
      error: reason,
    });
    await within(next, 'Next owner operation remained blocked');
    expect(cleanupSawExit).toBe(true);
    expect(nextSawExit).toBe(true);
    expect(nextSawLivePid).toBe(false);
    expect(events).toEqual(['exited', 'cleanup', 'next']);
    expect(await Bun.file(sessionPath).exists()).toBe(false);
    expect(expire).not.toHaveBeenCalled();
    expect(Buffer.from(sessions.getActive(USER_ID)!.encrypted_session).equals(encrypted)).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
  } finally {
    controller.abort(reason);
    if (child && !exited) child.kill('SIGKILL');
    await Promise.allSettled([lookup, next, child?.exited]);
    if (sessionPath) await realCleanup(sessionPath);
    spawn.mockRestore();
    cleanup.mockRestore();
    expire.mockRestore();
    db.close();
  }
});
