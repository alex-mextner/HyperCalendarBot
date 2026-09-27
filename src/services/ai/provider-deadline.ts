/** Stops waiting on an aborted operation even when its producer ignores cancellation. */
export async function waitForAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return operation();
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation();
      }),
      promise,
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bounds connection and stream together and disarms late callbacks on every exit. */
export async function withinProviderDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  parent?.throwIfAborted();
  const controller = new AbortController();
  const onParent = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', onParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Provider attempt timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await waitForAbort(() => operation(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', onParent);
    if (!controller.signal.aborted) controller.abort();
  }
}
