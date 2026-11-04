// A timeout reporter that keeps every report it is handed, so a test can count exactly how many a code path made:
// the real reporter folds repeats of one kind into an alert, which hides a duplicate.
import {
  configureTimeoutReporter,
  type TimeoutReport,
  TimeoutReporter,
} from '../../src/services/incident/timeout-reporter.ts';

class CountingReporter extends TimeoutReporter {
  readonly reports: TimeoutReport[] = [];

  constructor() {
    super(() => undefined);
  }

  override report(report: TimeoutReport): void {
    this.reports.push(report);
  }
}

/** Runs `body` with a counting reporter installed and removes it afterwards, whatever the outcome. */
export async function withCountingReporter(
  body: (reporter: { readonly reports: readonly TimeoutReport[] }) => Promise<void>,
): Promise<void> {
  const reporter = new CountingReporter();
  configureTimeoutReporter(reporter);
  try {
    await body(reporter);
  } finally {
    configureTimeoutReporter(null);
  }
}
