import { spawn } from 'node:child_process';
import { clampTimeoutMs } from '../timeout-clamp';

export interface ApplescriptResult {
  output: string;
  exitCode: number;
}

export function applescriptRun(script: string, timeoutMs = 30_000): Promise<ApplescriptResult> {
  const effectiveTimeoutMs = clampTimeoutMs(timeoutMs, 30_000);
  return new Promise((resolve) => {
    const proc = spawn('osascript', ['-e', script]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5_000);
    }, effectiveTimeoutMs);

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const stdoutText = Buffer.concat(chunks).toString('utf8').trim();
      const stderrText = Buffer.concat(errChunks).toString('utf8').trim();
      const output = stdoutText || stderrText;
      const exitCode = killed ? 124 : (code ?? 1);
      resolve({ output, exitCode });
    });
  });
}
