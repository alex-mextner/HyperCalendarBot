export interface DeadlineRun {
  output: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Runs a command to completion and returns its combined output. Bun.spawnSync blocks the event
 * loop, so the test runner's own timeout can only fire after the child has finished: a hung child
 * would stall the whole suite. The deadline here SIGKILLs the child and returns at the deadline,
 * reported as timed out with whatever it had printed. Only the direct child is killed; a
 * grandchild it forked is not awaited (it neither delays the return nor is it killed here).
 */
export function runWithDeadline(cmd: string[], cwd: string, deadlineMs: number): DeadlineRun {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: deadlineMs,
    killSignal: 'SIGKILL',
  });
  const decoder = new TextDecoder();
  return {
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
    exitCode: result.exitCode,
    signal: result.signalCode ?? null,
    timedOut: result.exitedDueToTimeout ?? false,
  };
}
