// src/utils/worker-alert.ts
// Creates a BullMQ worker 'failed' event handler that sends a Telegram alert
// and pushes to the admin alert queue (for mac-alert-watcher → Claude).

interface WorkerAlertDeps {
  botToken: string;
  adminId: number;
  /** Called synchronously — must not throw. Omit if ADMIN_ALERT_TOKEN is not set. */
  pushAlert?: (msg: string, source: string) => void;
}

export function makeWorkerFailureHandler(
  workerName: string,
  deps: WorkerAlertDeps,
): (job: { id?: string } | undefined, err: Error) => void {
  return (job, err) => {
    const jobId = job?.id ?? '?';

    const text = `🔴 <b>Worker failure: ${workerName}</b>\njob=${jobId}\n<code>${escapeHtml(err.message)}</code>`;
    fetch(`https://api.telegram.org/bot${deps.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: deps.adminId, text, parse_mode: 'HTML' }),
    }).catch(() => {
      // Non-critical fire-and-forget — Telegram may be temporarily unreachable
    });

    deps.pushAlert?.(`Worker failure [${workerName}] job=${jobId}: ${err.stack ?? err.message}`, 'worker');
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
