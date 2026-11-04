// A clock and timers a test advances by hand, for code that takes `now` and `schedule` as options.

export class ManualTime {
  nowMs = 1_000_000;
  private timers: { at: number; callback: () => void }[] = [];

  now = () => this.nowMs;

  schedule = (callback: () => void, ms: number): (() => void) => {
    const timer = { at: this.nowMs + ms, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((candidate) => candidate !== timer);
    };
  };

  advance(ms: number): void {
    this.nowMs += ms;
    const due = this.timers.filter((timer) => timer.at <= this.nowMs);
    this.timers = this.timers.filter((timer) => timer.at > this.nowMs);
    for (const timer of due) timer.callback();
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}
