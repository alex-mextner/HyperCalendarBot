# Reproducible bounded validation

`scripts/runpod_validation.py` is a Python 3.11+ wrapper around the installed
`runpod-run` helper. It does not replace the repository's full test gate. The
default command prints a plan without reading credentials or calling Runpod:

```sh
python3 scripts/runpod_validation.py --repo . \
  --artifacts /tmp/hcb-validation-artifacts \
  --ledger /tmp/hcb-validation-budget.json
```

For an approved paid run, choose durable private paths **outside the checkout**,
reuse the same cumulative ledger for every attempt, and add `--execute`.
Execution also requires `--confirm-storage-quote-day YYYY-MM-DD`: the operator
attests that today’s UTC official ephemeral disk tariff is at most
$0.10/GB-month. An absent/stale confirmation is refused before authentication;
the script does not fetch or invent a fresh storage quote.
A new ledger requires `--prior-upper AMOUNT`: include conservative costs of all
earlier authorized attempts, including disk storage; explicit `0` means none.
Do not replace the ledger to reset a budget. Its budget binding cannot increase.
The default total limit is $1; each attempt reserves at most $0.15. One attempt
uses `cpu3g-4` (4 CPUs, 16 GB memory), a 40 GB ephemeral disk and no network volume.
A live compute quote above $0.16/hour is refused. The storage-inclusive estimate
uses the planning assumption $0.10/GB-month (40 GB / 720 hours),
rounding up to $0.17/hour and reserving $0.085 for the 30-minute outer deadline.
This storage rate is a pinned planning assumption, not a freshly fetched
storage quote; revalidate it before approving a future paid execution.
This is a conservative reservation, not a billing receipt.

Only tracked source and repeated `--approve-untracked RELATIVE_PATH` arguments
enter the payload. A read-only frozen reference and a separate verified writable
execution copy have identical hashes; `rsync -a` must preserve writable modes
for the remote runner’s Git/dependency setup. Ignored files, symlinks, private configuration, databases and
runtime/evidence directories are refused. The wrapper verifies SHA-256 content
before copying and requires `gitleaks dir --redact` to succeed before the helper
can upload. Private artifacts and manifests remain outside source. A missing
scanner stops execution. No key, SSH registration, balance top-up or access
change is performed; the helper uses existing account credentials and SSH key.
Prerequisites on the calling machine are Python, Git, Gitleaks, GNU `timeout`,
and the installed helper with its documented dependencies.

Setup installs Node from the existing Ubuntu package source, verifies Node 18+
and pins Bun 1.4.2. It downloads the official standalone Docker Compose v5.6.0
Linux x86-64 binary and verifies its SHA-256 before execution. Compose tests use
configuration rendering and synthetic shell stubs; no Docker daemon, nested
container privileges or Docker socket are required. Playwright installs its
headless Chromium through the repository's existing command. Dependencies and
public setup downloads occur only during an explicitly authorized execution.

With default `--workers 1`, the canonical command is exactly
`bun --no-env-file test`, preserving `bunfig.toml` coverage requirements.
`--workers 2` first runs a native Bun parallel diagnostic with isolation, then
**always** runs the same unflagged canonical gate. Diagnostic counts/coverage
never substitute for or merge into the canonical result. A canonical receipt
requires zero failures/skips, complete summary, coverage of at least 80%, and a
file count matching the immutable test inventory. Child/scoped summaries alone
cannot satisfy it. This wrapper has no CI/review/merge bypass.

Each attempt gets a unique name and fresh helper state. The remote command is
limited to 600 seconds; GNU timeout sends TERM to the overall helper after 20
minutes and allows up to 10 minutes for cleanup. The wrapper stops waiting
after 29 minutes, reserving the final minute for bounded independent API checks;
all provider calls after creation share the monotonic 30-minute deadline.
Provider transfers use both curl’s total timeout and a subprocess deadline,
with a 2 MiB body limit and no redirects; authentication is passed by stdin and `curl --disable` is the first option.
The helper receives an isolated CURL_HOME with an explicitly empty `.curlrc`,
so ambient curl configuration cannot add request destinations. The wrapper verifies exact
pod ID, unpredictable name, owner and resource shape. Only that owned pod can
be deleted. Before metadata acceptance, callback/setup errors hard-kill only
the owned local helper process group, avoiding its unverified EXIT trap; the
wrapper then reconciles and deletes only independently proven own resources.
A buffered creation line does not eliminate a malicious-control-plane race;
unknown creation/identity remains failed and blocks another attempt. Success requires an independent GET 404 and the v2 Pod schema’s explicit
`mounts: {}` showing no persistent/network mount, rather than a helper log saying it stopped.
Creation ambiguity is reconciled by the exact unique name, never by a broad
host prefix. Authentication, identity, cleanup or API outage errors produce a
failed/unknown receipt and keep the reservation; an unresolved attempt blocks
a later helper run. Cloud API outages cannot guarantee timely deletion: inspect
the private receipt and resolve the exact owned resource before any new run.
There is no automatic paid retry or more expensive resource fallback.

Billing is queried only for the exact owned pod and its UTC date range.
No records means **UNKNOWN**, not free. Reported components must match their
total; the ledger retains the larger of the report, reservation and elapsed estimate. Unknown
resource shape or cleanup leaves the cost bound UNKNOWN and blocks another
attempt. Historical wall timestamps describe billing periods, not deadlines.
The private manifest, helper log, receipt and shared ledger support audit.

Local synthetic verification (no API, key reads, helper or upload):

```sh
python3 -m unittest discover -s test/python -p test_runpod_validation.py -v
```

The mocked tests establish local admission/orchestration contracts. They do not
prove a new live resource run, billing settlement or production deployment.
