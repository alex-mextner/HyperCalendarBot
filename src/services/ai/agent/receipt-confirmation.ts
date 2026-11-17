// A confirmation of a finished run's calendar writes built only from the tool results themselves:
// each event with its exact title and local weekday, day and time. Used when the response validator
// is unavailable or rejected the answer, so no model prose (which could carry unbacked facts) is
// sent. It reads the run's tool evidence and asks the write ledger only whether every write landed cleanly.
import { t, toLang } from '../../../config/constants.ts';
import { describeCalendarDay } from '../../../utils/date.ts';
import type { EventSummary } from '../../intent/variable-resolver.ts';
import { extractEventSummaries } from '../event-summaries.ts';
import type { ToolEvidence } from '../response-grounding.ts';
import { isMutationTool } from '../tool-executor.ts';
import type { WriteOutcomes } from '../write-outcomes.ts';
import { inert, type ReceiptView } from '../write-receipt.ts';

const RECEIPT_VERBS = { create_event: 'created', update_event: 'updated', delete_event: 'deleted' } as const;
type ReceiptVerb = (typeof RECEIPT_VERBS)[keyof typeof RECEIPT_VERBS];

function receiptVerbOf(toolName: string): ReceiptVerb | null {
  return Object.hasOwn(RECEIPT_VERBS, toolName) ? RECEIPT_VERBS[toolName as keyof typeof RECEIPT_VERBS] : null;
}

/** "вторник, 5 марта, 09:00": the local day and clock of an event. */
function whenLabel(event: EventSummary, language: string): string {
  const lang = toLang(language);
  const { day, weekday } = describeCalendarDay(event.date, lang);
  return `${weekday}, ${day}, ${event.time ?? t(lang).writeOutcomes.receipt.allDay}`;
}

/** A write into a calendar the requester manages for someone else: only the ledger names that calendar. */
function writesForAnotherOwner(write: ToolEvidence, requesterId: number): boolean {
  const owner = write.input.owner_id;
  return owner !== undefined && owner !== null && Number(owner) !== requesterId;
}

/**
 * Null unless the run made at least one calendar write and every recorded write landed cleanly (a
 * failed, skipped or uncertain write, an undelivered invitation or a declined attendance keeps the
 * guard notice instead). In a private chat each created, updated or deleted timed event is named
 * with its exact title and local time. In a group, or when a write is another kind of tool, returned
 * no event, is all-day or went into another owner's calendar, the ledger's own summary stands in:
 * it hides targets in groups, names the calendar, dates an all-day event from what was written (the
 * summary reads a floating UTC midnight in the user's zone, the day before west of UTC) and never
 * says "interrupted".
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
  const body = hideTargets ? null : eventLines(view, writes);
  const lines = body ?? writeOutcomes.summary(view);
  if (!lines) return null;
  return [tr.intro, lines, tr.outro].join('\n');
}

/** One bullet per distinct event and verb, or null when any write cannot be named from its own result. */
function eventLines(view: ReceiptView, writes: readonly ToolEvidence[]): string | null {
  const { language, requesterId } = view;
  const tr = t(toLang(language)).writeOutcomes.receipt;
  const lines = new Map<string, string>();
  for (const write of writes) {
    const verb = receiptVerbOf(write.name);
    const event = write.success ? extractEventSummaries(write.data)?.[0] : undefined;
    if (!verb || !event || event.all_day || writesForAnotherOwner(write, requesterId)) return null;
    const text = `• ${(write.alreadyExists ? tr.alreadyThere : tr[verb])(inert(event.title), whenLabel(event, language))}`;
    if (!write.alreadyExists) {
      lines.set(`${verb}:${event.id}`, text);
      continue;
    }
    // A repeat answered "already exists" is the event itself: a creation of this run already stands for it.
    if (!lines.has(`${verb}:${event.id}`)) lines.set(`existing:${event.id}`, text);
  }
  return [...lines.values()].join('\n');
}
