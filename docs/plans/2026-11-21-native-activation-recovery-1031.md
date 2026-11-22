# Native activation deadline and recovery — HCB #1031

Task: https://github.com/alex-mextner/HyperCalendarBot/issues/1031

Base: `0850fd11830f3caa6d5759a61186618b9197eab3`. This work owns only the
two native release helpers, the early compatibility refusal in the legacy local
caller, focused regression tests, and the deployment protocol documentation. Production admission remains held until reviewed source,
canonical CI, release effects and installed helper identity are verified.

## Security and data integrity

1. Reproduce stage loss and missing process isolation with benign local fixtures.
   Preserve artifact/main/status/digest checks, token isolation, schema rollback
   guards and the rule that automatic rollback never restores an older database.
2. Give the outer helper a fixed 2700 second forward budget measured from wrapper
   start, then at most 1500 seconds for recovery. Start the inner activation in
   a separate session. Cancellation targets only that owned candidate group.
3. Publish a versioned, SHA-bound activation outcome in a fresh private root-owned
   control directory outside the extracted stage. Ignore artifact-supplied markers.
   A supervised inner helper leaves cleanup to its outer supervisor. Cleanup is
   allowed only after the child has exited and reports preflight failure before
   mutation, verified runtime, or completed rollback.
4. Retain the stage and return an unresolved outcome when recovery is skipped,
   fails, exceeds its grace, or lacks a trustworthy terminal outcome. Do not retry
   activation or perform a second database restore. Repeated cancellation must
   not interrupt an already running rollback; the final hard bound may terminate
   only the owned candidate group after recording unknown and retention, and still
   leaves an unresolved hold. These budgets are Calendar-specific.

## Reliability and verification

5. Run only focused, benign tests for the changed contract, one test file at a
   time. Real Docker, credentials, production HTTP, Telegram and live signals are
   outside these checks. Full project verification belongs to canonical CI.
6. Before any future ship, inspect the actual main workflow and post-ship effects.
   A merge may deploy the application and is not described as source-only.
   The root-installed outer helper requires a separate accepted installation.
7. Coordinate the native review queue with the G1 owner; no approval or review
   credit is transferred from other tasks. Record exact diff/tree and installed
   identity before changing Calendar's production capability.

## Related work and limits

The caller currently has a 4500 second transport ceiling in Rig. The proposed
4200 second native forward plus recovery window leaves 300 seconds of transport
margin; it does not prove success after an unresponsive host or a lost channel.

Existing stage QA, source provenance and release gates remain in force.
https://github.com/alex-mextner/HyperCalendarBot/issues/640 concerns preservation
of staging after a schema refusal and is not claimed complete by this narrower
interrupted-recovery change. Enrollment work in
https://github.com/alex-mextner/HyperCalendarBot/issues/1022 owns a different
worktree and remains separate.

## Implementation state

The two helpers now carry the fixed native budget, owned-session cancellation,
private control handshake and explicit terminal outcomes. Both incompatible
outer/inner pairings refuse before runtime mutation. The shell's recovery
transition is serialized with the supervisor cancellation, and a blocked phase
writer cannot disable the hard bound. The supervisor preserves unresolved
evidence separately from the inner's terminal record.

Focused process fixtures execute the actual Python supervisor and actual shell
recovery block with benign children. Existing wrapper and prebuilt fixtures now
supply the real private control contract. Full project tests remain canonical CI;
the source is not installed or accepted for production yet.

The main workflow automatically deploys after merge. Release order is accepted
merge, wait for the old-caller attempt to finish/refuse, verify no release owner
while holding both deploy locks, atomically install the accepted outer bytes,
then an ordinary real workflow rerun and exact runtime/QA proof. The legacy local
fallback and standalone schema-override caller remain refused until separately
updated; #640 remains the existing broader staging/recovery follow-up. Common Rig
Calendar admission and audited helper pins remain unchanged until takeover proof.


## Review correction

The trusted private request now carries an absolute forward deadline and the
fixed minimum activation reserve. Shared-lock waiting is capped by that remaining
budget; the inner checks it immediately after acquiring that lock and again
before a runtime swap. A known insufficient reserve returns retry status 75.
Recovery commands share the remaining fixed allowance and leave time for terminal
proof; evidence, schema guard, compose and health cannot each restart that clock.
Recovery is attempted even when its phase record cannot be written. The inner
shell retains the existing private phase lock through recovery, so a stale
forward record cannot authorize another TERM to bounded recovery commands. The
supervisor may read a bound atomic record while that lock is busy only to retain
the same recovery deadline; missing proof still retains the hold. Preflight
cleanup ignores repeated handled cancellation only before a runtime child exists.
A restored image with an unhealthy full verdict remains held, even when an
individual health probe answered successfully.
Runtime verification prevents an older-image rollback, but a matching
release receipt must also publish before the terminal outcome can be `verified`.
Receipt failure preserves that runtime and retains the attempt.

Protocol version 3 checks the minimum reserve before control creation and again
before child launch. The child publishes its forward phase only after installing
recovery traps, so a cancellation during startup waits for bound readiness; the
hard ceiling and unknown retention still apply. The same private request carries
the recovery grace consumed by both helpers. Health-budget refusal clears any
previous verdict. After the matching receipt is written, optional public probes,
alias updates and retention are bounded and best effort. A verified terminal
record, zero child exit and a fully exited process group determine success even
if cancellation arrived during that optional tail. Missing terminal proof or log
preservation still retains the attempt. The Python supervisor creates the staging
directory only after interpreter startup; failed shell exec creates no directory.
An existing stage path is refused before cleanup is armed. An uncatchable
termination during artifact preparation can still leave an owned pre-control
directory; it requires exact operator inventory before cleanup and is not
permission for a broad automatic deletion.

The supervisor and protocol probe start from `/`, and inline Python uses isolated
mode. Both clean and retained outcomes expose a bounded private-log tail without
relaxing the cleanup conditions. The legacy fallback now refuses before expensive
verification/build/upload; its historical implementation remains for a separate
reviewed caller update. Existing stage workflows stay active until their replacement
has real PR stage, QA, cleanup and recovery proof.

Retained attempts block new preparation and are rechecked under the service
lock. Clearance requires explicit root runtime/configuration/database recovery
proof under both deployment locks, with the journal preserved. There is no
automatic clearance or additional database restore.

Child output is a private regular file and cannot block on SSH backpressure.
The supervisor uses nonblocking status writes and preserves completed logs
outside the bot-owned logs tree. SIGUSR1, SIGUSR2 and SIGQUIT are ignored by the
supervisor; arbitrary operator process suspension is not a supported cancellation
path. Grace expiry and an unreapable child retain unknown state.

Early cancellation publishes its actual earlier deadline in the existing private
control directory before the single TERM. The inner validates its exact request
and child binding and consumes only that remaining allowance. A failed handoff
never sends TERM with an unshared deadline; the hard bound and unknown hold remain.
Protocol-v2 peers are refused before activation. Optional image retention unwinds
its current subprocess on timeout, while any genuinely unfinished group still
retains the attempt. The watchdog script is copied into the owned control directory
and published by atomic replacement only after a complete copy. No partial copy
replaces the previously installed watchdog.
