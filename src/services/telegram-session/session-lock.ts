/** Personal-session operations share a process-wide queue keyed by the account owner. */
const pendingSessions = new Map<number, Promise<void>>();

export async function withTelegramSessionLock<T>(
  userId: number,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const previous = pendingSessions.get(userId) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  pendingSessions.set(userId, release.promise);
  const result = Promise.withResolvers<T>();
  const abortWaiting = () => {
    if (signal?.aborted) result.reject(signal.reason);
  };
  signal?.addEventListener('abort', abortWaiting, { once: true });

  // The caller may stop waiting, but its queue slot still belongs to the predecessor.
  void previous.then(async () => {
    // Once work starts, retain its result even if cancellation races an acknowledgement.
    signal?.removeEventListener('abort', abortWaiting);
    try {
      signal?.throwIfAborted();
      result.resolve(await operation());
    } catch (error) {
      result.reject(error);
    } finally {
      release.resolve();
      if (pendingSessions.get(userId) === release.promise) pendingSessions.delete(userId);
    }
  });
  return result.promise;
}
