// Fakes for tests of spawn deadlines, which would otherwise need a real Python interpreter and a real
// minute-long wait: a subprocess that never finishes on its own, and a way to take the kill timers
// out of the clock so the test fires them itself.
import { type Mock, mock, spyOn } from 'bun:test';

/** What `proc.exited` resolves to once the fake has been killed. */
export const KILLED_EXIT_CODE = 137;

/** The slice of a Bun subprocess the bridge and the service tier use. */
export interface HangingProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write: () => number; flush: () => Promise<number>; end: () => number };
  exited: Promise<number>;
  kill: Mock<() => void>;
}

/** A fake process and the spy on its kill(), so a test can ask how often it was killed. */
export interface HangingProcessHandle {
  process: HangingProcess;
  kill: Mock<() => void>;
}

/**
 * A subprocess whose stdout and stderr stay open until kill() closes them and resolves `exited`
 * the way a SIGKILLed child does. `firstLine` is written to stdout up front, like a script that
 * answers and then keeps running.
 */
export function hangingProcess(options: { firstLine?: string } = {}): HangingProcessHandle {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const openStream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
      },
    });
  const stdout = openStream();
  const stderr = openStream();
  if (options.firstLine !== undefined) controllers[0]?.enqueue(new TextEncoder().encode(`${options.firstLine}\n`));

  let exit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    exit = resolve;
  });
  let killed = false;
  const kill = mock(() => {
    if (killed) return;
    killed = true;
    for (const controller of controllers) controller.close();
    exit(KILLED_EXIT_CODE);
  });
  const stdin = { write: () => 0, flush: async () => 0, end: () => 0 };
  return { process: { stdout, stderr, stdin, exited, kill }, kill };
}

export interface SpawnStub {
  restore(): void;
}

/** Makes `Bun.spawn` hand out the given processes in order. Call `restore()` when done. */
export function stubSpawn(...processes: HangingProcess[]): SpawnStub {
  const queue = [...processes];
  const spy = spyOn(Bun, 'spawn').mockImplementation((() => {
    const next = queue.shift();
    if (!next) throw new Error('Bun.spawn called more often than the test queued processes');
    return next;
  }) as unknown as typeof Bun.spawn);
  return { restore: () => spy.mockRestore() };
}

export interface DeadlineCapture {
  /** Runs the handler of the last timer armed for this duration, as if that time had passed. */
  fire(ms: number): void;
  restore(): void;
}

/** Timers armed for exactly these durations are captured instead of scheduled; all others run normally. */
export function captureDeadlines(...durations: number[]): DeadlineCapture {
  const realSetTimeout = globalThis.setTimeout;
  const armed = new Map<number, () => void>();
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if (ms === undefined || !durations.includes(ms)) return realSetTimeout(handler, ms);
    armed.set(ms, handler);
    // clearTimeout on the captured timer must stay harmless.
    return 0;
  }) as unknown as typeof setTimeout;
  return {
    fire(ms) {
      const handler = armed.get(ms);
      if (!handler) throw new Error(`no ${ms} ms timer was armed`);
      handler();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}
