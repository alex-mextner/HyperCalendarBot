# Blocker conversation calls: minimum safe bring-up

## Current evidence

- Reuse `ServiceTier`, `CallManager`, `CallSessionManager`, `CallSession` and the
  Pyrogram bridge. Do not create another Telegram login or reuse personal sessions.
- Service identity is fail-closed and designated separately from per-user sessions.
  Source availability does not prove the deployed account is authorized.
- Current call TTS is Silero/Kokoro/Google. The requested Bracho persona needs an
  explicit TTS adapter; do not silently substitute a different voice.
- AISIS currently specifies extraction; its checked-out repository has documentation
  and schema checks, not a deployed call API. No native `call_user` tool is available.

## Priority 1: safe diagnostics (this change)

Run in the existing deployment environment, using its existing service Python:

```sh
venv/bin/python scripts/voice-preflight.py --root .
```

This command reads package metadata, checks executable and session-file presence,
and reports only environment variable names/presence. It never loads `.env`, reads
session contents, imports the transport, starts a process, contacts a provider or
dials. Missing keys may mean the command is outside the service environment; never
copy credentials to make this report green. Empty values count as missing (`empty`),
matching the fail-closed ServiceTier/env parsing; non-empty values remain explicitly
unvalidated. Exit 3 means missing prerequisites; exit 4 means inventory complete but
live readiness unproven (codes chosen so argparse usage errors (2) and crashes (1)
are never mistaken for a result). It never returns readiness success.

## Priority 2: operational proof and voice adapter

1. Locate the actual authorized deployment and existing service Python. Reuse the
   service-tier identity probe through its existing configuration boundary; record
   enabled/disabled reason only. Do not create a session if authorization is absent.
2. Verify patched ntgcalls build provenance, media conversion, STT and model
   connectivity without placing a call. Package presence/version cannot prove the
   network-availability fix is present in the loaded binary.
3. Connect the existing home Bracho TTS provider to the injected `synthesize` seam.
   Validate generated PCM and voice selection locally; no audio playback is needed.
4. Provide a bounded conversation adapter to the requesting agent, rather than
   binding blocker conversations to calendar tools. Enforce exact owner recipient,
   blocker-only dispatch, one attempt per incident, explicit timeout/cancel and
   unknown-outcome handling. No blind retry or third-party recipients.

## Priority 3: acceptance, after specific test-call consent

Ask for one explicitly scheduled test to the verified owner. Require audible audio
on the receiver, caller-to-agent STT, Bracho replies, interruption, hangup and timeout
proof. Never treat permission to call for an important blocker as test-call consent.
Only then mark transport readiness and enable blocker dispatch. Voice replies must
retain existing authenticated approval policy for sensitive actions.

## Deferred findings

- Runtime deployment/session health on home is unverified; next action is inventory
  inside the existing service environment, without credential extraction.
- AISIS/tg-cli extraction remains separate work; preserve the calendar transport
  until bidirectional production parity is demonstrated.
- Bracho model identity and endpoint binding are unverified; samples and HA entity
  names are evidence of assets, not proof of the call's selected voice.
