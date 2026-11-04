// A confirmation of a finished run's calendar writes built only from the tool results themselves:
// each event with its exact title and local weekday, day and time. Used when the response validator
// is unavailable, so no model prose (which could carry unbacked facts) is sent. It reads the run's
// tool evidence and asks the write ledger only whether every write landed cleanly.
import { t, toLang } from '../../../config/constants.ts';
import { describeCalendarDay } from '../../../utils/date.ts';
import type { EventSummary } from '../../intent/variable-resolver.ts';
import { extractEventSummaries } from '../event-summaries.ts';
import type { ToolEvidence } from '../response-grounding.ts';
import { isMutationTool } from '../tool-executor.ts';
import type { WriteOutcomes } from '../write-outcomes.ts';
import type { ReceiptView } from '../write-receipt.ts';

const RECEIPT_VERBS = { create_event: 'created', update_event: 'updated', delete_event: 'deleted' } as const;
type ReceiptVerb = (typeof RECEIPT_VERBS)[keyof typeof RECEIPT_VERBS];

function receiptVerbOf(toolName: string): ReceiptVerb | null {
  return Object.hasOwn(RECEIPT_VERBS, toolName) ? RECEIPT_VERBS[toolName as keyof typeof RECEIPT_VERBS] : null;
}

/** "вторник, 5 марта, 09:00": the local day and clock of an event, or "весь день". */
function whenLabel(event: EventSummary, language: string): string {
  const lang = toLang(language);
  const { day, weekday } = describeCalendarDay(event.date, lang);
  const clock = event.all_day || !event.time ? t(lang).writeOutcomes.receipt.allDay : event.time;
  return `${weekday}, ${day}, ${clock}`;
}

/**
 * Null unless the run made at least one calendar write and every recorded write landed cleanly (a
 * failed, skipped or uncertain write, an undelivered invitation or a declined attendance keeps the
 * guard notice instead). In a private chat each created, updated or deleted event is named with its
 * exact title and local time. In a group, or when a write is another kind of tool or returned no
 * event, the ledger's own summary stands in: it hides targets in groups and never says "interrupted".
 */
export function buildReceiptConfirmation(
  view: ReceiptView,
  toolEvidence: readonly ToolEvidence[],
  writeOutcomes: WriteOutcomes,
): string | null {
  const { language, hideTargets } = view;
  const writes = toolEvidence.filter((tool) => isMutationTool(tool.name, tool.input));
  if (writes.length === 0) return null;
  if (writeOutcomes.finalNotice(view) !== null) return null;

  const tr = t(toLang(language)).writeOutcomes.receipt;
  const body = hideTargets ? null : eventLines(language, writes);
  const lines = body ?? writeOutcomes.summary(view);
  if (!lines) return null;
  return [tr.intro, lines, tr.outro].join('\n');
}

/** One bullet per distinct event and verb, or null when any write cannot be named from its own result. */
function eventLines(language: string, writes: readonly ToolEvidence[]): string | null {
  const tr = t(toLang(language)).writeOutcomes.receipt;
  const lines = new Map<string, string>();
  for (const write of writes) {
    const verb = receiptVerbOf(write.name);
    const event = write.success ? extractEventSummaries(write.data)?.[0] : undefined;
    if (!verb || !event) return null;
    lines.set(`${verb}:${event.id}`, `• ${tr[verb](event.title, whenLabel(event, language))}`);
  }
  return [...lines.values()].join('\n');
}
