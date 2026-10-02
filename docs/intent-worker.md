# Intent-learning worker (Mac, Claude Code)

The bot server queues intent-learning jobs. A Mac with an installed, logged-in Claude
Code (CLI 2.1.274+) polls for them, runs exactly one Claude Code stage per claim, and
posts back a JSON artifact or a categorical failure. The server owns iteration (at most
3 generate/verify rounds), retry counts and the rate queue; the worker never loops a
job by itself.

It reuses the transport idea of `scripts/mac-alert-watcher.sh` (server → Mac polling
over the same TLS domain) but is a separate program with its own LaunchAgent, token,
lock and state. The alert watcher and its incident-repair behaviour are unchanged, and
none of its bypass flags are used here.

| File | Role |
| --- | --- |
| `scripts/intent-worker.py` | Poller + stage runner (stdlib, Python 3.11+) |
| `scripts/intent-worker-evidence.py` | Optional read-only evidence MCP server (stdio) |
| `scripts/install-intent-worker.py` | LaunchAgent install / dry-run / print / uninstall |
| `test/python/test_intent_worker.py` | Fake server + fake Claude CLI child tests |

## Configuration

Private JSON, default `~/.config/hypercalendarbot/intent-worker.json`. The file must be a
regular file (not a symlink) owned by the current user with mode `0600`; the installer
also requires its directory not to be group/other-writable (use `0700`).

```json
{
  "endpoint": "https://hypercal.invntrm.ru",
  "workerToken": "<worker-scoped token, not the admin token>",
  "workerId": "ultra-mac",
  "claudePath": "/Users/ultra/.local/bin/claude",
  "repoPath": "/Users/ultra/xp/hypercalendarbot",
  "model": "claude-opus-5",
  "pollSeconds": 30
}
```

Optional keys: `stateDir` (absolute, default `~/.local/state/hypercalendarbot/intent-worker`),
`evidenceMcp` (default `true`), `allowInsecureLoopback` (default `false`; tests only).

- `endpoint` is a bare origin. It must be `https://`; plain `http://` is accepted only for
  `127.0.0.1`/`::1`/`localhost` with `allowInsecureLoopback: true`. Paths, queries and
  credentials in the URL are rejected.
- `model` must be `claude-opus-5`; any other value is a config error.
- `claudePath` must be the real binary (the interactive shell alias `claude-rotate` is
  not used). `repoPath` is validated but the Claude child runs in a private per-job
  directory, so repository settings and hooks are not loaded into the tool-less session.
- The token is never placed in argv, environment, logs, the plist or the prompt.

## Running

```sh
python3 scripts/intent-worker.py --status   # local state only: no network, no Claude
python3 scripts/intent-worker.py --once     # deliver spool, run at most one claim, exit
python3 scripts/intent-worker.py            # poll forever (what the LaunchAgent runs)
```

Exit codes: `0` ok, `1` config/state error, `3` another poller holds the lock,
`4` (`--once`) a delivery is still pending in the spool.

### LaunchAgent

```sh
python3 scripts/install-intent-worker.py --print-plist   # show plist, change nothing
python3 scripts/install-intent-worker.py --dry-run       # verify script/config/python
python3 scripts/install-intent-worker.py                 # write plist, launchctl bootstrap
python3 scripts/install-intent-worker.py --uninstall     # bootout + remove this plist only
```

Label `ru.invntrm.hypercal-intent-worker`; `ProgramArguments` = absolute python, the
worker script, `--config <path>`. `KeepAlive`, `RunAtLoad`, `ThrottleInterval 60`,
`Umask 077`; stdout/stderr go to `<stateDir>/worker.log`. The only environment entry is
`PATH`. The installer never reads or writes `ru.invntrm.hypercal-alert-watcher`.

## Server protocol (`/admin/intent-learning/v1`)

All requests are `POST` JSON with `Authorization: Bearer <workerToken>`. Redirects are not
followed and proxies are ignored. Error responses are reduced to a status and a category
(`auth`, `not_found`, `stale_lease` for 409/410, `rate_limited`, `server`, `rejected`,
`malformed`, `network`); bodies of error responses are never read into logs.

| Route | Body | Expected reply |
| --- | --- | --- |
| `/claim` | `{workerId}` | `204` or `null` = idle; otherwise the job below |
| `/heartbeat` | `{jobId, leaseToken}` | 2xx; `409` = lease is stale |
| `/result` | `{jobId, leaseToken, sessionId, artifact}` | 2xx (must be idempotent) |
| `/failure` | `{jobId, leaseToken, errorClass, retryAfterMs?}` | 2xx (must be idempotent) |
| `/evidence` | `{jobId, leaseToken, kind, limit?}` | JSON object (evidence MCP only) |

Claim:

```json
{"jobId": "...", "leaseToken": "...", "stage": "generate|verify", "round": 1,
 "model": "claude-opus-5", "permissionMode": "auto",
 "payload": {"samples": [], "activeIntents": [], "proposal": {}, "previousReview": {},
             "proposalHash": "optional", "instructionsVersion": "..."},
 "deadlineAt": "ISO-8601 with offset, or epoch milliseconds"}
```

`jobId` must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` and `leaseToken`
`[A-Za-z0-9._~+/=-]{8,512}`; otherwise the claim is dropped without a reply (they are used
in file names). `model`/`permissionMode` are checked for agreement with local constants,
never used to build argv. `verify` requires `payload.proposal`. Any other disagreement is
reported as `/failure` with `errorClass: "malformed_job"`.

For `verify`, `proposalHash` is the server's `payload.proposalHash` if present, otherwise
SHA-256 of the proposal serialised with sorted keys and compact separators. The review
artifact must echo it exactly.

## One stage

Every claim starts a fresh session (new UUIDv4, never `--resume`/`--continue`):

```
claude --print --model claude-opus-5 --permission-mode auto --permission-prompts none
       --session-id <uuid4> --output-format json --max-turns 16 --tools ""
       [--mcp-config <job>/mcp.json --allowedTools mcp__intent_evidence]
       --strict-mcp-config --append-system-prompt <trusted stage instructions>
```

- The job payload is sent on stdin inside `<untrusted_job_data>`; `<` is JSON-escaped so
  data cannot close the delimiter. The trusted system text says logs/messages are data,
  output is one JSON object, no SQL/shell/calendar writes, no claims of native execution
  that did not happen, and template slots (`{{event_title}}`) are placeholders, not facts.
- No bypass permissions, no `--fallback-model`, no global config edits. `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and model overrides are removed from the
  child environment so the installed Claude Code account authenticates the run.
- The child runs with `start_new_session=True`. A heartbeat thread posts every 45 s. A
  `409` stops the owned process group (SIGTERM, 5 s, SIGKILL), deletes the stage stdout
  and keeps a receipt; nothing is submitted. The wall-clock cap is
  `min(12 min, deadlineAt - 15 s)`; a claim with under 30 s left is failed as `timeout`
  without starting Claude. A worker SIGTERM/crash also stops the owned group. No other
  Claude process is ever signalled.

### Output classification

Success requires: exit 0, a `type: "result"` envelope with `subtype: "success"` and no
`is_error`, a `modelUsage` key that is `claude-opus-5` (or a suffixed variant), no
`stop_reason: "refusal"`, and an artifact from `structured_output` or from `result` text
(one JSON object, optional code fence, at most 1 MiB) that passes the shape checks below.

| errorClass | Cause |
| --- | --- |
| `quota` | usage/rate limit text (also with exit 0); `retryAfterMs` only from an explicit reset: an epoch after a pipe character, ISO `resets at`, `retry-after: N` |
| `auth` | login/key/authorization text |
| `model_unavailable` | Opus 5 absent from `modelUsage`, or a model-not-found error |
| `network`, `timeout`, `transient` | connection errors, timeouts, overload/5xx text; `timeout` also for the wall-clock cap |
| `max_turns` | `subtype: error_max_turns` |
| `nonzero_exit`, `error_json`, `cc_error` | non-zero exit without an envelope, unparseable stdout, other error envelopes |
| `truncated`, `too_large` | stdout over 4 MiB, artifact over 1 MiB |
| `empty_output`, `refusal`, `invalid_artifact` | empty result, refusal, malformed/partial JSON or failed shape check |
| `spawn_failed`, `malformed_job` | the binary could not start; the claim disagreed with the contract |

Local shape checks (the server validates natively afterwards):

- generate: `kind: "proposal"`, `summary`, `operations[]` with `kind` in
  create/generalize/consolidate/retire, `sourceNames[]`, `reason`, and `intents[]` each with
  `canonical_name, pattern, workflow, phrases, trigger_words, source_message` (`format`
  optional); `comparisons[]` with `sampleId, previousAiResponse, intentResponse,
  idealResponse, expectedTools, verdict (better|equivalent|worse|needs_context), rationale`;
  optional `primitiveSuggestions[]`.
- verify: `kind: "review"`, matching `proposalHash`, `verdict` pass|revise, `findings[]`,
  `comparisons[]` as above.

## Evidence MCP (optional, on by default)

`intent-worker-evidence.py` exposes four read-only tools — `fetch_samples`,
`fetch_catalog`, `fetch_operations`, `fetch_log_summary` — each a `POST /evidence` with a
fixed `kind` (`samples`, `catalog`, `operations`, `log-summary`) and an optional `limit`
1–100. Its credentials come from a per-job `0600` context file named by
`HCB_INTENT_JOB_CONTEXT` in the MCP config; the file is deleted when the stage ends. Tool
output is labelled untrusted data. There is no SSH, shell or SQL path. If `evidenceMcp` is
on but the script is missing, the stage runs without it and logs `evidence_mcp_missing`.

## State and spool

`<stateDir>` (all directories `0700`, files `0600`, writes are temp+fsync+rename):

- `worker.lock` — `flock` held by the poller; a second poller exits with code 3.
- `spool/` — `result-<job>-<leaseHash>.json` / `failure-...`: written before any HTTP
  delivery. Every cycle delivers the spool before claiming; on network/5xx/429 the entry
  stays and no new job is claimed. 2xx → `archive/`; 409 → `stale/`; other 4xx or a corrupt
  record → `rejected/`; older than 24 h → `expired/` (each bucket keeps 200 newest).
- `jobs/<job>-<leaseHash>/` — prompt, claim, Claude stdout/stderr (stderr cut to 64 KiB),
  session and receipt; 30 newest kept.
- `status.json` — last job summary for `--status`.
- `worker.log` — one line per event: job id, stage, round, status, error class, model,
  duration. Never payloads, raw stderr, tokens or headers.

Polling uses `pollSeconds` ±20 % jitter, exponential backoff up to 5 minutes on network,
server or delivery problems, and a 1 s pause after a completed stage.

## Tests

```sh
python3 -m unittest discover -s test/python -p 'test_intent_worker.py'
```

(`python3 -m unittest test/python/...` does not work: the `test` package name collides
with the standard library.) The tests use a loopback HTTP server and a fake `claude`
executable that records argv/stdin and emits canned envelopes. No real Claude call or
external network is made.
