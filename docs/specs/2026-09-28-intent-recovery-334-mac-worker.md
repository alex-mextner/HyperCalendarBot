# GH-334 Scope 4: Mac Claude Code intent worker

Status: draft for review (2026-09-28). Task: GH-334. Implemented by PR-3. Server side:
`docs/specs/2026-09-28-intent-recovery-334-learning-service.md`. Prior design (unmerged):
`cc-intent-worker-20260919/docs/intent-worker.md` and `scripts/intent-worker.py`; the superset copy in
`intent-evolution-release-20260919` is the port source.

## Goal

A LaunchAgent on the owner's Mac polls the server, runs exactly one Claude Code stage per claim with
`claude-opus-5` in `--permission-mode auto`, and posts back one JSON artifact or a categorical failure.
The server owns iteration; the worker never loops a job, never approves anything and has no path to
run commands on the server.

## Fixed facts (verified 2026-09-28 on this Mac)

- Claude Code CLI 2.1.283; the real binary is `/Users/ultra/.local/bin/claude`. The interactive
  `claude` is an alias to `claude-rotate`, and a cmux shim is first on `PATH`; neither is used.
- `claude -p ... --model claude-opus-5 --permission-mode auto --output-format json` succeeded with
  `modelUsage` containing only `claude-opus-5` (raw receipt kept privately by the state-map recon).
- The `cc` shell alias uses `bypassPermissions`; it is never used by the worker or its installer.

## Reuse and non-reuse of the alert watcher

Reused: the transport idea of `scripts/mac-alert-watcher.sh` (Mac pulls from the server over the same
TLS domain, so the server never needs to reach the Mac). Not reused: its `GET /admin/alerts/next`
endpoint (a destructive pop without lease, acknowledgement or retry), its `ADMIN_ALERT_TOKEN`, its
LaunchAgent label, and its bypass-level Claude launch with full repository access.

## Contract

As in the 2026-09-19 `docs/intent-worker.md` (configuration file rules, `https`-only endpoint,
LaunchAgent label `ru.invntrm.hypercal-intent-worker`, spool/state layout, exit codes, error class
table, fresh UUID session per stage, `--tools ""` plus the optional read-only evidence MCP,
`--strict-mcp-config`, child environment stripped of `ANTHROPIC_*` overrides, process-group
termination on stale lease), with these changes:

1. Stages are `assess`, `generate`, `verify` (the server runs `simulate` itself). `assess` returns
   `{kind: "assessment", items: [{sampleId, idealResponse, class, needsContext[], rationale}]}`.
2. Delivery acceptance requires a 2xx **and** a JSON body `{accepted: true, outcome: string}`; a 2xx
   with any other body stays in the spool as `malformed` and is retried with backoff (the old "any 2xx
   is acceptance" rule is removed).
3. Minimum CLI version check: `claude --version` >= 2.1.283 at startup and in `--dry-run`; the
   installer refuses a `claudePath` that is a symlink into `claude-rotate` or a shell script.
4. The argv builder is a pure function with a unit test that asserts the exact list and asserts the
   absence of `--dangerously-skip-permissions`, `bypassPermissions`, `--resume`, `--continue`,
   `--fallback-model` and `acceptEdits`.
5. The worker records the `session_id` it passed and the one reported in the result envelope; a
   mismatch is `cc_error`, never submitted.

## Security properties

- Worker credentials: its own `INTENT_WORKER_TOKEN` only; never the admin or alert token. The token is
  read from a 0600 file in a 0700 directory and never appears in argv, environment, plist, logs or the
  prompt.
- Scoped evidence: the evidence MCP can only call `POST /evidence` with the four fixed kinds for the
  current lease; its per-job context file is deleted when the stage ends.
- Untrusted data: the job payload is passed on stdin inside `<untrusted_job_data>` with `<` escaped;
  the trusted system text forbids tool use beyond the MCP, writes and claims of execution.
- Logs: one line per event (job id, stage, round, status, error class, model, duration); never
  payloads, stderr bodies, tokens or headers.

## Acceptance (PR-3)

Python unittest with a loopback fake server and a fake `claude` executable:
1. Exact argv for each stage; forbidden flags absent; model mismatch in the envelope -> `model_unavailable`.
2. Two stages of one job use two different session UUIDs; neither `--resume` nor `--continue` appears.
3. A `quota` envelope with exit 0 is posted as `/failure` with `errorClass: "quota"` and the parsed reset.
4. A 2xx without `{accepted: true}` keeps the spool entry; a 409 moves it to `stale/` and kills nothing
   but the owned process group.
5. Stale lease on heartbeat terminates the child within 5 s and submits nothing.
6. The token string never appears in the recorded argv, environment, log file or prompt file.

Contract test (TypeScript, in PR-3, depends on PR-2): the real `/admin/intent-learning/v1` handler on
a temporary sidecar answers the Python worker's recorded requests (fixtures written by the Python
test) with the shapes the worker accepts, and a worker token on `/approve` gets 403.

Live proof after merge (not a CI test): install the LaunchAgent, enqueue one synthetic corpus job
built from the anonymized fixture, observe a real Opus `assess`, `generate`, `verify` with three
distinct session ids recorded server-side, and the resulting draft visible in `/intents`; no approval
is performed as part of the proof.
