# Reusable call-lib and tg-call adapter — proposed design

Status: design for review, not an implemented library or operational call tool.
Source baseline: HyperCalendarBot `d9b57f1`; offline preflight PR #759.

## Intent and boundaries

The requesting agent needs to reach the owner when an important action blocks work,
explain the specific blocker, and converse in real time using the Bracho persona.
Success means audible bidirectional conversation, interruption and hangup, exact
owner routing, bounded latency and one dispatch per incident. Notification playback
alone does not satisfy this requirement.

Reuse the calendar transport as library code. Calendar, AISIS and tg-cli become
clients of that library; no calls through a calendar bot command, QA browser or bot
HTTP endpoint as a proxy. No new Telegram login, copied credentials, persistent
grant or account substitution is part of extraction. Existing service-account
authentication is a prerequisite, not an authorization to expand its capabilities.
Docker socket access, deployment and real calls remain outside this local phase.

## Options

1. **Recommended: `packages/call-lib` in tg-cli plus a thin `tg-call` entrypoint.**
   The core is pure/injected; an independent host adapter owns transport I/O.
   This fits tg-cli's thin-entrypoint/pure-module discipline and gives calendar and
   AISIS one versioned dependency without a new repository during initial extraction.
2. **Independent call-lib repository/package.** Same contract and safety boundaries,
   but adds package release and cross-repository CI work before parity is demonstrated.
   Move there later if the package requires an independent release lifecycle.

Repository placement does not decide credential ownership. A deployment host must
already have an authorized service environment. If no such host is available, local
extraction still proceeds against fakes and production dispatch stays disabled.

## Concrete extraction map

| Existing code | Proposed library/module | Change required |
| --- | --- | --- |
| `src/services/voice/call-session.ts` | `core/conversation.ts` | Keep session/VAD/STT event logic; move calendar `createCallAgent` into calendar adapter; inject logger, text cleanup and media storage |
| `call-session-manager.ts` | `core/session-registry.ts` | Keep registration and lifecycle; remove server binding/port 3001 from core; inject timer and close |
| `call-manager.ts` | `core/call-runner.ts` | Remove calendar log status, reminder translations and bot failure messages; inject transport handle and lifecycle sink |
| `types.ts` | `core/contracts.ts` | Retain language/audio contracts; replace eventId/callLogId reminder job with generic call request |
| `flux-streaming-stt.ts`, `nova-streaming-stt.ts` | `providers/deepgram/` | Preserve existing implementations with injected socket factories and configured providers |
| `interruption-classifier.ts` | `core/interruptions.ts` | Preserve tested classifier semantics |
| `thinking-phrase-player.ts` | `core/thinking.ts` | Inject phrase catalogue; disable old voice phrases until Bracho phrases are supplied |
| `scripts/voice-call-bridge.py` | `transports/telegram/python/bridge.py` | Preserve Pyrogram/ntgcalls/media logic; inject session root and endpoint rather than hardcoded cwd/port |
| `service_session.py`, `mtproto_lock.py` | `transports/telegram/python/` | Keep exact account-ID check, noninteractive connect and serialized session access |
| `service-tier.ts` call capability | `transports/telegram/service-account.ts` | Extract identity/startup guard only; leave profile/birthday lookup and other calendar capabilities in calendar |
| `src/worker/call-queue.ts` | calendar adapter | Keep calendar scheduling in calendar; don't require BullMQ/Redis for immediate blocker calls |

Extraction must retain the Python transport and patched ntgcalls provenance. No
attempt to reimplement WebRTC in TypeScript or expose credentials to a CLI client.
Existing calendar code stays operational until exact library parity tests pass.

## Minimum contracts

The following are interface sketches, not exported implementation:

```ts
type CallPurpose = 'calendar_reminder' | 'important_blocker' | 'consented_test';
type CallState = 'prepared' | 'ringing' | 'connected' | 'listening' |
  'thinking' | 'speaking' | 'completed' | 'failed' | 'unknown';

interface ConversationRequest {
  incidentKey: string;
  recipientBindingId: string;
  purpose: CallPurpose;
  opener: string;
  language: 'ru' | 'en';
  persona: 'bracho';
  deadlineMs: number;
}

interface ConversationAgent {
  turn(input: { callId: string; turnSequence: number; transcript: string },
       signal: AbortSignal): Promise<{ speech: string; endCall: boolean }>;
}

interface CallHandle {
  callId: string;
  events: AsyncIterable<{ sequence: number; state: CallState }>;
  cancel(): Promise<void>;
}
```

Service host supplies `RecipientPolicy`, `ConversationAgent`, `SpeechProvider`,
`StreamingStt`, `Transport`, `MediaStore`, `Clock` and `LifecycleStore`. Clients never
provide arbitrary Telegram recipient IDs, service IDs, session paths or API hashes.
The recipient binding resolves only the configured owner for blocker/test purposes;
calendar calls preserve their existing separate recipient authorization policy.
The host derives the principal and task scope from its authenticated connection or
configured single-owner execution context, never a client-supplied principal field.
Peer UID alone does not distinguish multiple agents using the same OS account.
Reject an unbound/impersonated context and scope incident keys to the verified
principal and task; absence of an approved context leaves dispatch disabled.

## Account and authorization guards

1. Host uses its existing service session in place; no credential extraction/export.
2. Reject absent/invalid designated service ID, missing API configuration/session,
   failed identity probe and any identity mismatch before constructing transport.
3. `start_service_session` again confirms `get_me().id` equals the designated ID;
   never call interactive `Client.start` or fall back to a user's session.
4. Preserve the shared session lock. Do not run calendar and generic owners against
   the same session concurrently without one transport owner and ownership agreement.
   The host supplies one canonical session directory and lock path to every service
   script. Current `mtproto_lock.py` derives its path from module location; extraction
   must remove that assumption so both adapters lock the same file for the same
   session. Moving the Python module alone must never create a second lock namespace.
5. Host policy must explicitly permit `important_blocker` for this principal and
   owner binding. Existing reminder capability alone does not enable that purpose.
6. Test calls require consent tied to recipient and specific test window. General
   blocker-call permission does not authorize a test or a third-party recipient.
7. Voice replies never authorize sensitive writes. Route required decisions to the
   existing authenticated approval surface and explain where the owner can approve.

## tg-call wiring and live agent seam

`tg-call doctor --offline` uses the existing preflight. The proposed runtime entrypoint
imports call-lib, receives an injected authorized transport and long-lived agent turn
port, and emits structured lifecycle events. It does not shell out to calbot/QA.

For same-host client/server deployment, propose a mode-0600 Unix socket owned by the
service user with peer-UID validation; it is local IPC, not a new remote credential.
No server is installed or persistent access created by this design. A different-host
deployment needs an already approved authenticated route; if absent, that is a
separate operator action, never an implicit new grant or an unauthenticated TCP API.

The generic session calls `ConversationAgent.turn` for every transcript. Calendar's
adapter preserves `createCallAgent`; AISIS may supply its authorized Gateway adapter.
The requesting agent needs its own supported turn adapter before CLI blocker calls
can be enabled. Native `call_user` and a supported bridge into this Codex thread are
not currently available. Do not claim a detached CLI or a spec can produce this
conversation automatically; no undocumented desktop RPC or synthetic approval.

## Bracho provider and media

Read-only nonsecret evidence on home:

- `/home/ultra/voice-design/models.json` selects Bracho model
  `5cd1ffa5dbb4419cb5766435139c6d92`, title `Брачо (A3)`, source
  `bracho_A_2.wav`, recorded state `trained`.
- Source file metadata: 573484 bytes; RU sample `samples/bracho_ru.mp3`: 107414 bytes.
  Neither audio content was opened or played.
- HA Fish Audio integration passes `reference_id=voice_id`, configured `model=backend`
  and requests MP3. That code confirms the provider interface; it does not establish
  this deployment's active backend, credential validity or entity binding.
- Nonsecret entity-registry metadata identifies `tts.bracho_bracho`, platform
  `fish_audio`, original name `Брачо`, with no `disabled_by` or orphaned timestamp.
  Config entries and credentials were not read; the association between this entity
  and the model manifest's exact voice ID still needs an authorized provider check.

`SpeechProvider` receives the exact Bracho voice selection from nonsecret config,
and an already configured provider client from the host's secret boundary. Convert
its output through the existing media path into the format the bridge expects;
validate channel/rate, frame count and nonzero energy using synthetic fixture audio.
Do not silently fall back to Silero/Kokoro/Google or historical thinking phrases:
unavailable Bracho is a structured failure. No private sample cloning or bulk audio
reads are needed. Actual provider synthesis remains a separately authorized probe.

## Reliability and minimum acceptance

- Persist incident reservation before ringing. One attempt per incident; duplicate
  requests return existing state. A timeout or bridge disconnect after dispatch is
  `unknown`, never a signal to ring again blindly.
- Separate bridge process exit from answered call/audio-delivery proof. `completed`
  requires explicit conversation end; a zero exit alone cannot prove heard speech.
- Bound ring, turn and overall time; cancellation aborts agent/STT/TTS and closes
  transport. Ignore late callbacks after terminal state and reclaim temporary media.
- Transcript events carry call and turn sequence; reject stale/cross-call responses.
- Keep raw incoming PCM memory-only as current bridge tests require. No transcript
  persistence by default; record lifecycle/reasons without sensitive call content.
- Namespace temporary media per validated session ID and constrain bridge PLAY paths
  to the host's media directory. Preserve loopback-only bridge connectivity; authenticate
  bridge registration independently of a guessable URL or caller-supplied call ID.
- Assert binary build provenance against patched ntgcalls source/wheel receipt. A
  package version, ringing or connected event cannot establish RTP audio delivery.

## Ordered execution plan and next verifiable increment

1. Finish current PR's full offline checks with CI Bun version. Record failures
   separately from extraction; no runtime configuration edits.
2. After design approval, create tg-cli worktree and `packages/call-lib`; move the
   generic session and injected contracts, retain calendar adapter in calendar.
   Copy/adapt the existing call-session, session-manager and interruption tests;
   add fake agent→STT→TTS→transport turn and cancellation tests. No dial path in tests.
3. Package Python bridge + service ID/lock guards, preserving their existing identity,
   caller-audio and no-disk regressions. Add identity mismatch/unauthorized/wrong-owner
   tests and injected transport commands; test fakes must observe zero start calls.
   Add a shared-session lock regression across calendar and tg-cli adapters and an
   impersonated-principal/context test; cross-principal incident keys cannot collide.
4. Add Bracho provider adapter with synthetic MP3/PCM fixtures and exact model-selection
   assertions. Add explicit voice-unavailable failure and forbid alternate-voice fallback.
5. Add thin tg-call wiring using an injected transport and supported agent turn port.
   Tests cover duplicate incident, unknown outcome, cancellation, cross-call isolation,
   late answer and unauthorized purpose/recipient. Calendar parity then enables library
   consumption in calendar; no temporary calbot proxy.
6. Only on the existing authorized host: inventory configuration presence, validate
   service identity and patched-binary receipt. Account/grant absence stays blocked.
   Run local synthesis/STT/media probes when separately authorized.
7. Only after specific owner test-call consent: one live end-to-end conversation with
   receiver audio proof, STT, exact Bracho voice, interruption and timeout/hangup.

The next implementation result is an offline library session with a fake transport
and one conversational turn; it is not an end-to-end Telegram call. Runtime host,
provider binding and requesting-agent turn port remain explicit unresolved operational
prerequisites. No deployment or account permission is inferred from this document.
