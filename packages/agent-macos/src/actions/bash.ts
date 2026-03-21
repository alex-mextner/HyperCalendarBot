import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 50 * 1024;
const SIGKILL_DELAY_MS = 5_000;

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function truncate(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.length <= MAX_OUTPUT_BYTES) {
    return { text: buf.toString('utf8'), truncated: false };
  }
  return {
    text: buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8') + '\n[output truncated at 50 KB]',
    truncated: true,
  };
}

export function bashExecute(command: string, timeoutMs = 60_000): Promise<BashResult> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', ['-c', command], { env: process.env });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let killed = false;
    const killTimer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, SIGKILL_DELAY_MS);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      const stdout = truncate(Buffer.concat(stdoutChunks)).text;
      const stderr = truncate(Buffer.concat(stderrChunks)).text;
      const exitCode = killed ? 124 : (code ?? 1);
      resolve({ stdout, stderr, exitCode });
    });
  });
}
