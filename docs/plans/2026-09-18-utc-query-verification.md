# UTC query correctness and measured cost — issue 308

## Evidence
The requested accounts had 460 active rows at the audit: 256 Z, 127 date-only and 77 explicit-offset start values. Those are format counts, not a count of broken events. Eight synthetic real-SQLite regressions all failed before the fix. They cover midnight crossing, endpoint precision, upcoming exclusion, chronology, overlaps, group range and membership time fences.

The final tests also pin inclusive endpoints, exactly touching default-duration overlap, recurrence exception read/reparent/delete boundaries, and fail-closed behavior on corrupt legacy values. No real user values are rewritten; existing strict versus inclusive comparisons and ownership/participation clauses are retained. `ORDER BY` uses actual instant then id for deterministic ties.

## Runtime and corruption preflight
A read-only probe of the real production Bun SQLite returned SQLite 3.51.2 and equality for both offset-vs-Z and T-vs-space timestamps. Across all 507 active event rows: invalid start=0 and invalid non-null end=0; across 31 membership rows: invalid joined_at=0. This is a dated checkpoint, not an ongoing health claim.

`bun --no-env-file scripts/audit-event-timestamps.ts --database PATH` repeats a read-only aggregate audit, additionally checking recurrence original_start_at. It emits no titles, descriptions, actor IDs or conversations and exits nonzero on incompatible runtime semantics or malformed active timestamps. Corrupt values fail closed in queries; use the audit to surface them rather than lexically granting visibility.

## Query-cost tradeoff
A bounded native benchmark generated 100,000 canonical UTC events over 100 synthetic owners. It ran 25 measured `getVisibleInRange` calls after warmup and verified identical result sets (12 rows) for the canonical dataset.

| Implementation | Median | p95 |
| --- | ---: | ---: |
| Original lexical query | 5.505 ms | 5.696 ms |
| Correct actual-instant query | 9.873 ms | 10.051 ms |

This is a roughly 1.8x cost increase on that synthetic in-memory query, not zero overhead and not a production latency measurement. Plain timestamp text indexes cannot directly satisfy the new expression range/order. Existing owner/group equality indexes may still help. Expression indexes are deliberately deferred to a separately reviewed migration: the current prebuilt deployment disallows unexpected migration changes, and current data volume is much smaller than the stress fixture. Reassess indexing at 100,000 rows or sustained p95 above 50 ms; never restore incorrect lexical semantics as an optimization.

The initial benchmark harness/log are retained in the authorized workspace under `/private/tmp/hcb-utc-range-benchmark.ts` and `.log`; its original-vs-candidate comparison must be pinned before either source is replaced. This document records the measured checkpoint, not a reusable benchmark claim.

## Boundaries
Date-only all-day values retain existing service semantics; this patch does not redefine their timezone. No production batch replay or broad date normalization is performed. A reproduced membership predicate defect is not proof that any third party accessed private historical events. Real recipient identity work remains separate.
