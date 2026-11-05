// Asynchronous picture delivery for EVERY picture the bot sends: the AI tools (render_day_image,
// render_week_image, render_month_image, render_table) and, through queue-picture.ts, /today,
// /tomorrow, /week, /month, the agenda buttons and the conflict picture of an accepted invitation.
//
// Why: on 2026-11-01 (prod, bb7a9d47) the tool call waited for the render inside the agent turn. On the
// overloaded odroid real renders took 73-80 s, two waits plus model rounds spent the whole ~90 s turn
// budget, the answer validator timed out and the user got an aborted-run notice instead of the correct
// text the model had already written. Now the tool only ENQUEUES: it returns at once ("queued, not
// sent") and this service finishes the job in the background:
//
//   enqueue ──► render (BullMQ, bounded) ──► send as its own message ──► log the outcome
//                  │ timeout  → ONE honest note to the user + reportTimeout({kind:'render'})
//                  │ failure  → ONE honest note to the user + one aggregated alert of its own kind (none when Telegram's refusal is permanent)
//                  │ upload of unknown end → ONE note that the picture MAY not have arrived + the same alert
//                  │ shutdown → with the store: no note, the row stays queued and the next start resumes it;
//                  │            without the store: ONE note (best effort within the shutdown deadline); logged 'interrupted'
//
// A render never blocks or fails the agent turn. Invariants (each has a test):
//  - Same chat, same picture twice (same slot and same payload) → one render, one delivery.
//  - Same chat, same slot, different payload (the data changed) → the older one is superseded, so the
//    user gets only the newest.
//  - At most MAX_PENDING_PER_CHAT pending pictures per chat (the conflict pictures of accepted invitations
//    count apart, MAX_PENDING_CONFLICT_PER_CHAT) and MAX_PENDING_TOTAL overall: the shared
//    host is CPU-bound; beyond that the tool says so honestly and nothing is queued.
//  - A calendar write for the picture's data while it renders makes it stale: it is rebuilt from the
//    current data once instead of delivering a picture that contradicts the text the user already has.
//  - Every pending delivery ends in exactly one logged outcome. With the store, a process killed without a
//    graceful shutdown (SIGKILL, crash, power) is reconciled by the next start (resumed, expired with one
//    "the bot was restarting" note and no timeout alert, or marked unknown and never re-sent); without the store
//    (tests, dev) those pictures are lost silently.
import { TelegramError } from 'gramio';
import { t } from '../../config/constants.ts';
import type {
  ImageDeliveryEndState,
  ImageDeliveryRepository,
  ImageDeliveryRow,
} from '../../database/repositories/image-delivery.repository.ts';
import { IMAGE_DELIVERY_RETENTION_MS } from '../../database/repositories/image-delivery.repository.ts';
import { agendaImageErrorMessage, agendaImageTooLarge } from '../../utils/agenda-image.ts';
import { imageLogger } from '../../utils/logger.ts';
import { isPermanentTelegramError } from '../../worker/broadcast-queue.ts';
import type { ImageRenderJob } from '../../worker/image-render.queue.ts';
import { reportIfDatabaseBusy } from '../incident/database-busy.ts';
import { reportTimeout } from '../incident/timeout-reporter.ts';
import { type ImageRenderer, RenderAbortedError, RenderTimeoutError } from './render-service.ts';

/**
 * How long a picture may take from the tool call to the end of its render. Measured production renders
 * took 6–15 s healthy and 73–80 s when the host was overloaded (2026-11-01); 150 s is about twice the
 * worst of those. The jobs are CPU-bound on a box shared with other bots, so a longer bound would only
 * pile more work on it; the user already has the text answer and can ask again.
 */
export const IMAGE_DELIVERY_BOUND_MS = 150_000;
/** The Telegram upload of a finished PNG; a hang here must not hold a chat's slot forever. */
export const IMAGE_SEND_BOUND_MS = 30_000;
export const MAX_PENDING_PER_CHAT = 2;
/** Schedule comparisons of accepted invitations queued for one chat at a time; they have their own limit (see `enqueue`). */
export const MAX_PENDING_CONFLICT_PER_CHAT = 4;
/** Schedule comparisons queued on the whole bot at a time: the chats' own pictures always keep the other half of MAX_PENDING_TOTAL. */
export const MAX_PENDING_CONFLICT_TOTAL = 6;
export const MAX_PENDING_TOTAL = 12;
/** A render that has to be redone after a calendar write only starts with at least this much of the bound left (the slow host needs ~15 s, worst seen 80 s). */
export const REBUILD_MIN_BUDGET_MS = 45_000;
/** What shutdown spends on telling users their pending picture will not come (the whole deadline is 8 s). */
export const SHUTDOWN_NOTICE_BUDGET_MS = 1_500;
/**
 * A recovered delivery whose bound ran out more than this long ago gets no "it did not arrive" note and no
 * timeout alert: the cause was downtime (a rollback, a long outage), not a slow render, and the user stopped
 * waiting long ago. Within it (a normal deploy restart) the user is told once.
 */
export const RECOVERY_NOTE_MAX_AGE_MS = 10 * 60_000;
/** An outcome the store refused is written again after this long times the attempt number, RECORD_RETRIES times at most. */
export const RECORD_RETRY_MS = 1_000;
export const RECORD_RETRIES = 3;

export type ImageKind = 'day' | 'week' | 'month' | 'table' | 'conflict';

export interface ImageDeliveryRequest {
  chatId: number;
  language: 'ru' | 'en';
  kind: ImageKind;
  /** What the user asked for (a date, a week, a month, a table title): shown only in that user's own failure note, never logged. */
  label: string;
  /** Pictures of the same slot show the same thing at different times; a newer one replaces an older pending one. */
  slot: string;
  /** The Telegram message (or callback query) this picture answers; part of the deterministic delivery id. Defaults to the enqueue time. */
  requestId?: number | string;
  /** Whose calendar the picture shows: a user id (that user's writes make it stale) or the group (any write does); absent for pictures of no calendar data (a table). */
  dataOwner?: number | 'group';
  /** The render job from the CURRENT calendar data; called again once when the data changed meanwhile. */
  buildJob(): ImageRenderJob;
  /** Delivers the finished PNG to the chat as its own message and returns the Telegram message id. */
  send(png: Buffer): Promise<number>;
  /** Sends a short note to the same chat. */
  notify(text: string): Promise<unknown>;
}

export type ImageEnqueueResult =
  | { status: 'queued' }
  /** An identical picture is already pending for this chat. */
  | { status: 'duplicate' }
  /** The same request (same message, same picture) already ran to its end: delivered, or the user was told it failed. Nothing was queued. */
  | { status: 'settled' }
  /** The chat (or the bot) already has the maximum of pending pictures; nothing was queued. */
  | { status: 'busy' }
  /** The bot is shutting down; nothing was queued. */
  | { status: 'closed' };

export type ImageDeliveryOutcome =
  | 'delivered'
  | 'failed'
  | 'timed_out'
  | 'superseded'
  | 'interrupted'
  | 'unknown'
  /** Another attempt (a process that overlapped this one during a deploy) already claimed the send: nothing was uploaded here. */
  | 'claimed_elsewhere';

/** The facts an outcome log line carries beyond the delivery's identity. */
export interface ImageOutcomeDetails {
  phase?: 'send' | 'render' | 'recovery';
  delivery?: 'unknown' | 'not_started';
  messageId?: number;
  errorName?: string;
  expected?: boolean;
  recovered?: boolean;
  stale?: boolean;
  resumable?: boolean;
}

export interface RenderFailureReport {
  kind: ImageKind;
  jobType: ImageRenderJob['type'];
  /** The class name of the error; never its message. */
  errorName: string;
  elapsedMs: number;
}

/** What a recovered delivery uses after a restart, when the request's own closures are gone. */
export interface ImageTransport {
  /** Sends the PNG as a photo (document when oversized) and returns the Telegram message id. */
  sendImage(chatId: number, png: Buffer, language: 'ru' | 'en'): Promise<number>;
  notify(chatId: number, text: string): Promise<unknown>;
}

export interface ImageDeliveryDeps {
  renderer: ImageRenderer;
  /** Durable record of each delivery; without it (tests, dev) nothing survives a restart. */
  store?: ImageDeliveryRepository;
  /** A render that failed for a reason other than time: one aggregated alert of its own kind. */
  reportFailure?: (report: RenderFailureReport) => void;
  now?: () => number;
  boundMs?: number;
  sendBoundMs?: number;
  /** Runs `fn` after `delayMs` (default: an unref'd timer). Only used to try again to write an outcome the store refused. */
  schedule?: (fn: () => void, delayMs: number) => void;
}

interface Entry {
  /** The deterministic delivery id; the BullMQ job id derives from it. */
  readonly id: string;
  /** How many times the job was rebuilt after a calendar write (each rebuild is its own BullMQ job). */
  rebuilds: number;
  readonly request: ImageDeliveryRequest;
  readonly startedAt: number;
  readonly deadline: number;
  /** Hash of the data the picture on its way shows; follows a rebuild, so the same request again is still recognised as this one. */
  payload: string;
  readonly abort: AbortController;
  job: ImageRenderJob;
  /** The calendar-change counter when `job` was built. */
  builtAtSeq: number;
  phase: 'rendering' | 'sending';
  /** Why the wait was cut from outside; the run then ends quietly. */
  cancelled?: 'superseded' | 'shutdown';
  settled: boolean;
  /** The end of the delivery could not be written to the store: the row never reached failed/expired, so no note can be claimed on it. */
  recordFailed?: boolean;
  /** The note went out while the end of the delivery was not recorded: it is claimed once the write finally succeeds, so a restart does not send it again. */
  noteUnclaimed?: boolean;
  /** The end of the delivery as the store has to hear it; set while the write is refused, cleared once it succeeds. */
  unrecorded?: { state: ImageDeliveryEndState; at: number; messageId: number | undefined };
  done: Promise<void>;
}

class SendTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`Image upload did not finish within ${limitMs} ms`);
    this.name = 'SendTimeoutError';
  }
}

/** The persisted state an outcome ends in: an upload of unknown end is `unknown`, a render cut by the bound `expired`. */
function storedState(outcome: ImageDeliveryOutcome, details: ImageOutcomeDetails): ImageDeliveryEndState {
  if (outcome === 'delivered') return 'delivered';
  if (outcome === 'unknown') return 'unknown';
  if (outcome === 'superseded') return 'superseded';
  if (outcome === 'timed_out') return details.phase === 'send' ? 'unknown' : 'expired';
  if (outcome === 'interrupted') return 'unknown';
  return 'failed';
}

/**
 * Deterministic: the same chat, request, kind, slot and payload always give the same id, so a repeated
 * enqueue is recognised and BullMQ (which ignores a job id it already has) never renders it twice.
 */
function deliveryId(request: ImageDeliveryRequest, payload: string, startedAt: number): string {
  const key = `${request.chatId}|${request.requestId ?? startedAt}|${request.kind}|${request.slot}|${payload}`;
  return `img-${Bun.hash(key).toString(16)}`;
}

/**
 * Identifies WHAT a picture shows, not WHEN it was built. The picture of today carries the clock (the
 * "now" line and the "Today" badge), so hashing it whole changed every minute: the same picture asked
 * again a minute later was a new delivery, and a calendar write could never be recognised as "nothing the
 * picture shows changed" for a render that took longer than a minute.
 */
function payloadOf(job: ImageRenderJob): string {
  const data =
    job.type === 'daily-agenda' ? { ...job.data, currentTimeMinutes: undefined, relativeDay: undefined } : job.data;
  return String(Bun.hash(JSON.stringify(data)));
}

/**
 * The note of a picture that did not arrive. Pictures the user can ask for again say so; the schedule
 * comparison of an accepted invitation cannot be requested by any command or tool, so its notes do not offer it.
 */
function imageNote(
  kind: ImageKind,
  language: 'ru' | 'en',
  which: 'failed' | 'timedOut' | 'interrupted' | 'undeliverable' | 'uncertain' | 'refused',
  label: string,
): string {
  const meta = t(language).aiTools.meta;
  // Telegram refuses pictures in this chat for good: asking again cannot help, so no picture kind offers it.
  if (which === 'refused') return meta.imageNoteRefused(label);
  if (kind === 'conflict') {
    if (which === 'failed') return meta.imageNoteFailedFinal(label);
    if (which === 'undeliverable') return meta.imageNoteUndeliverableFinal(label);
    if (which === 'uncertain') return meta.imageNoteUncertainFinal(label);
    return which === 'timedOut' ? meta.imageNoteTimedOutFinal(label) : meta.imageNoteInterruptedFinal(label);
  }
  if (which === 'failed') return meta.imageNoteFailed(label);
  if (which === 'undeliverable') return meta.imageNoteUndeliverable(label);
  if (which === 'uncertain') return meta.imageNoteUncertain(label);
  return which === 'timedOut' ? meta.imageNoteTimedOut(label) : meta.imageNoteInterrupted(label);
}

/**
 * Telegram's own answer says the upload was not accepted (a 4xx: bad request, blocked bot, flood wait), so the
 * picture did not land and the user can be told. Anything else thrown while uploading (a dropped connection,
 * an abort, a 5xx) says nothing about whether Telegram stored the message: that is an uncertain send.
 */
function uploadRefused(err: unknown): boolean {
  return err instanceof TelegramError && err.code < 500;
}

/**
 * Telegram refused the upload for a reason that will not change by asking again: the bot was blocked or removed
 * (403), the chat is gone (404, or 400 "chat not found"), or a group does not let the bot send photos. The user still
 * gets a note that does not offer to ask again (a group without photo rights can read text), but this is not a
 * defect of the bot, so it raises no alert, the same rule as the permanent failures of the broadcast worker.
 */
function permanentRefusal(err: unknown): boolean {
  if (!(err instanceof TelegramError)) return false;
  return (
    isPermanentTelegramError(err.code) ||
    (err.code === 400 && /not enough rights|no rights to send|chat not found/i.test(err.message))
  );
}

/** What a row in this state says about the same request arriving again. */
function repeatStatus(state: ImageDeliveryRow['state'] | undefined): 'duplicate' | 'settled' {
  return state === 'queued' || state === 'rendered' || state === 'sending' ? 'duplicate' : 'settled';
}

/**
 * Whether one more picture of this request's kind would pass a limit; `replaceable` pending pictures would be
 * replaced by it and so free their places. The schedule comparison of an accepted invitation is not something the
 * inviter asked for, so it neither uses up the chat's own limit (three guests accepting within one render would lose
 * the third picture for good) nor is refused by a limit its own pictures filled. It has its own per-chat and
 * bot-wide limits, so one chat (an event with many invitees accepting at once) cannot take the whole budget.
 */
function overLimits(request: ImageDeliveryRequest, active: readonly Entry[], replaceable: number): boolean {
  if (active.length - replaceable >= MAX_PENDING_TOTAL) return true;
  const inChat = active.filter((e) => e.request.chatId === request.chatId);
  if (request.kind === 'conflict') {
    const comparisons = active.filter((e) => e.request.kind === 'conflict');
    return (
      comparisons.length - replaceable >= MAX_PENDING_CONFLICT_TOTAL ||
      inChat.filter((e) => e.request.kind === 'conflict').length - replaceable >= MAX_PENDING_CONFLICT_PER_CHAT
    );
  }
  return inChat.filter((e) => e.request.kind !== 'conflict').length - replaceable >= MAX_PENDING_PER_CHAT;
}

/** Rejects with `onTimeout()` after `ms`, unless cleared. */
function deadlineAfter(ms: number, onTimeout: () => Error): { promise: Promise<never>; clear(): void } {
  const { promise, reject } = Promise.withResolvers<never>();
  promise.catch(() => {});
  const timer = setTimeout(() => reject(onTimeout()), Math.max(0, ms));
  return { promise, clear: () => clearTimeout(timer) };
}

export class ImageDelivery {
  private readonly pending = new Set<Entry>();
  private readonly now: () => number;
  private readonly boundMs: number;
  private readonly sendBoundMs: number;
  private closed = false;
  /** Deliveries whose end the store has refused so far; each is tried again, and once more at shutdown. */
  private readonly unrecordedEntries = new Set<Entry>();
  private transport: ImageTransport | undefined;
  /** Bumped by every calendar write; compared with the value a job was built at. */
  private seq = 0;
  private lastWriteSeq = 0;
  private readonly writeSeqByUser = new Map<number, number>();

  constructor(private readonly deps: ImageDeliveryDeps) {
    this.now = deps.now ?? Date.now;
    this.boundMs = deps.boundMs ?? IMAGE_DELIVERY_BOUND_MS;
    this.sendBoundMs = deps.sendBoundMs ?? IMAGE_SEND_BOUND_MS;
  }

  /**
   * Queues the picture and returns at once; the render and the delivery happen in the background.
   * Throws only when `buildJob` throws (the caller reports that as a failed tool call).
   */
  enqueue(request: ImageDeliveryRequest): ImageEnqueueResult {
    if (this.closed) return { status: 'closed' };
    const startedAt = this.now();
    const deadline = startedAt + this.boundMs;
    const job: ImageRenderJob = { ...request.buildJob(), expiresAt: deadline };
    const payload = payloadOf(job);
    const id = deliveryId(request, payload, startedAt);

    // Only a delivery still on its way counts: one that ended and is only telling the user (or waiting on a slow
    // Telegram call) must not hold a place against the limits.
    const active = [...this.pending].filter((e) => !e.cancelled && !e.settled);
    const sameChat = active.filter((e) => e.request.chatId === request.chatId);
    const sameSlot = sameChat.filter((e) => e.request.slot === request.slot);
    if (sameSlot.some((e) => e.payload === payload)) return { status: 'duplicate' };
    // The same request again after its row exists (see `knownRequest`).
    const known = this.knownRequest(id);
    if (known) return { status: known };
    // A different payload for the same slot means the data moved on: the older picture is the stale one.
    const replaceable = sameSlot.filter((e) => e.phase === 'rendering');
    if (overLimits(request, active, replaceable.length)) return { status: 'busy' };
    const raced = this.recordNew({ id, request, job, payload, startedAt, deadline });
    if (raced) return { status: raced };
    for (const older of replaceable) {
      // Settled at the moment of replacement, not when its run unwinds: a shutdown in between must not leave the
      // stale picture's row `queued` for the next start to send after the newer one.
      older.cancelled = 'superseded';
      this.settle(older, 'superseded', {});
      older.abort.abort();
    }

    this.start({
      id,
      rebuilds: 0,
      request,
      startedAt,
      deadline,
      payload,
      abort: new AbortController(),
      job,
      builtAtSeq: this.seq,
      phase: 'rendering',
      settled: false,
      done: Promise.resolve(),
    });
    return { status: 'queued' };
  }

  /**
   * The same request again after its row exists, asked before the limits so a redelivered update whose picture
   * already ended is never told "too many pictures". A live row is a picture on its way (this or the previous
   * process); a finished one means this very request was already answered. A superseded one is neither: that
   * picture never uploaded and nobody was told, so the request goes on (the data went back to what it showed),
   * unless the delivery that replaced it is still unwinding.
   */
  private knownRequest(id: string): 'duplicate' | 'settled' | undefined {
    const stored = this.deps.store?.get(id);
    if (!stored) return undefined;
    if (stored.state !== 'superseded') return repeatStatus(stored.state);
    return [...this.pending].some((e) => e.id === id) ? 'duplicate' : undefined;
  }

  /** Writes the new delivery's row. Not undefined when another connection recorded the same id between the lookup and the insert. */
  private recordNew(fresh: {
    id: string;
    request: ImageDeliveryRequest;
    job: ImageRenderJob;
    payload: string;
    startedAt: number;
    deadline: number;
  }): 'duplicate' | 'settled' | undefined {
    const { store } = this.deps;
    if (!store) return undefined;
    const { id, request, job } = fresh;
    const recorded = store.insert({
      id,
      chatId: request.chatId,
      language: request.language,
      kind: request.kind,
      label: request.label,
      jobType: job.type,
      slot: request.slot,
      payloadHash: fresh.payload,
      jobJson: JSON.stringify(job),
      createdAt: fresh.startedAt,
      expiresAt: fresh.deadline,
    });
    return recorded ? undefined : repeatStatus(store.get(id)?.state);
  }

  private start(entry: Entry): void {
    this.pending.add(entry);
    entry.done = this.run(entry)
      .catch((err: unknown) => imageLogger.error({ err, kind: entry.request.kind }, 'Image delivery run failed'))
      .finally(() => this.pending.delete(entry));
  }

  /** Recovery after a restart sends through this transport: the original request's closures died with the process. */
  attachTransport(transport: ImageTransport): void {
    this.transport = transport;
  }

  /**
   * Start-up reconciliation of what the previous process left in the store, each delivery exactly once:
   *  - `sending`: the upload was started and its end is unknown, so it may have landed. Marked `unknown`,
   *    NEVER retried (a retry could send a second picture) and the user is not told it failed.
   *  - past its bound (or without a payload): `expired`, ONE note to the user ("the bot was restarting"), no
   *    timeout alert: a row still `queued` after its bound means the previous process stopped before the bound
   *    (a running process records `expired` itself), so the cause is downtime, not a slow render.
   *  - otherwise (`queued`, `rendered`): the same BullMQ job id is awaited again, so a render that
   *    finished while the bot was down is picked up, one still waiting or running is waited for, and one
   *    the queue lost is rendered anew from the stored payload; it is then sent once and recorded.
   * A recovered picture is not rebuilt from fresh calendar data and is not pinned.
   */
  async reconcile(): Promise<void> {
    const { store, transport } =
      this.deps.store && this.transport ? { store: this.deps.store, transport: this.transport } : {};
    if (!store || !transport) return;
    const at = this.now();
    store.pruneOlderThan(at - IMAGE_DELIVERY_RETENTION_MS);
    const restarted = new Set<string>();
    for (const row of store.unfinished()) {
      if (row.state === 'sending') this.recoverUpload(row, store, at);
      else if (this.now() >= row.expires_at || !row.job_json) this.recoverExpired(row, store, at, restarted);
      else this.resume(row, row.job_json, transport);
    }
    // Ended as failed/expired (just now, or by the previous process which died before telling the user).
    for (const row of store.unnotified()) await this.recoveryNote(row, transport, restarted);
  }

  /** A row left `sending`: the upload may have landed, so it is `unknown` and never retried. */
  private recoverUpload(row: ImageDeliveryRow, store: ImageDeliveryRepository, at: number): void {
    store.finish(row.id, 'unknown', at);
    const stale = at - row.updated_at > RECOVERY_NOTE_MAX_AGE_MS;
    this.logOutcome('unknown', row, at, { delivery: 'unknown', recovered: true, stale });
    if (!stale) this.reportUncertain(row, at); // an upload cut off days ago is downtime's doing: no alert about it now
  }

  /** A row past its bound (or without a payload): `expired`; its note goes out in the pass after every live row was resumed. */
  private recoverExpired(
    row: ImageDeliveryRow,
    store: ImageDeliveryRepository,
    at: number,
    restarted: Set<string>,
  ): void {
    store.finish(row.id, 'expired', at);
    const stale = at - row.expires_at > RECOVERY_NOTE_MAX_AGE_MS;
    this.logOutcome('interrupted', row, at, { phase: 'recovery', recovered: true, stale });
    // A slow Telegram call must not make a finished picture miss its deadline, so no note is sent here.
    if (stale)
      store.markNoteSent(row.id); // claimed unsent: the unnotified pass must not tell a user days later
    else restarted.add(row.id);
  }

  /** The one note of a recovered failed/expired delivery; recorded before it is sent, so it is never repeated. */
  private async recoveryNote(
    row: ImageDeliveryRow,
    transport: ImageTransport,
    restarted: ReadonlySet<string>,
  ): Promise<void> {
    if (row.note_sent || !this.deps.store?.markNoteSent(row.id)) return;
    if (this.now() - row.updated_at > RECOVERY_NOTE_MAX_AGE_MS) return; // claimed unsent: the user stopped waiting long ago
    const text = imageNote(
      row.kind as ImageKind,
      row.language === 'ru' ? 'ru' : 'en',
      row.state === 'failed' ? 'failed' : restarted.has(row.id) ? 'interrupted' : 'timedOut',
      row.label,
    );
    await transport
      .notify(row.chat_id, text)
      .catch((err: unknown) =>
        imageLogger.warn({ err, kind: row.kind }, 'Image delivery: the recovery note could not be sent'),
      );
  }

  private resume(row: ImageDeliveryRow, jobJson: string, transport: ImageTransport): void {
    const language = row.language === 'ru' ? 'ru' : 'en';
    const kind = row.kind as ImageKind;
    const job = JSON.parse(jobJson) as ImageRenderJob;
    this.start({
      id: row.id,
      rebuilds: row.rebuilds,
      request: {
        chatId: row.chat_id,
        language,
        kind,
        label: row.label,
        slot: row.slot,
        buildJob: () => job,
        send: (png) => transport.sendImage(row.chat_id, png, language),
        notify: (text) => transport.notify(row.chat_id, text),
      },
      startedAt: row.created_at,
      deadline: row.expires_at,
      payload: row.payload_hash,
      abort: new AbortController(),
      job,
      builtAtSeq: this.seq,
      phase: 'rendering',
      settled: false,
      done: Promise.resolve(),
    });
  }

  private reportUncertain(row: Pick<ImageDeliveryRow, 'kind' | 'job_type' | 'created_at'>, at: number): void {
    try {
      this.deps.reportFailure?.({
        kind: row.kind as ImageKind,
        jobType: row.job_type as ImageRenderJob['type'],
        errorName: 'UncertainSend',
        elapsedMs: at - row.created_at,
      });
    } catch (err) {
      imageLogger.error({ err }, 'Image delivery: the uncertain send could not be reported');
    }
  }

  /** A calendar write happened for this user (domain events): pending pictures of their data are stale. */
  eventsChanged(userId: number): void {
    this.seq++;
    this.lastWriteSeq = this.seq;
    this.writeSeqByUser.set(userId, this.seq);
  }

  /** Resolves when no delivery is pending. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending].map((e) => e.done));
  }

  /**
   * Shutdown: stop accepting and log each picture still rendering as interrupted. With the store (always in
   * production) no note is sent: the row stays queued, the BullMQ job is kept and the next start resumes it.
   * Only without a store is the user told once, within the shutdown budget (best effort: a stuck Telegram call
   * only logs a warning). A picture already being uploaded gets a short grace; if it does not finish, its
   * outcome is unknown and the user is not told it failed.
   */
  async close(budgetMs = SHUTDOWN_NOTICE_BUDGET_MS): Promise<void> {
    this.closed = true;
    const entries = [...this.pending];
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.phase === 'sending') {
          const grace = deadlineAfter(budgetMs, () => new Error('send grace over'));
          await Promise.race([entry.done, grace.promise]).catch(() => {});
          grace.clear();
          // The upload may still land: the same alert a crash at this point raises at the next start.
          if (!entry.settled && this.settle(entry, 'interrupted', { delivery: 'unknown' })) {
            this.reportUncertain(
              { kind: entry.request.kind, job_type: entry.job.type, created_at: entry.startedAt },
              this.now(),
            );
          }
          return;
        }
        // Already ended (superseded, or told its outcome): nothing to interrupt, and its recorded end must stay what it is.
        if (entry.settled || entry.cancelled) return;
        entry.cancelled = 'shutdown';
        // 'shutdown' tells the renderer to stop waiting but keep the queued BullMQ job: the next start picks it up.
        entry.abort.abort('shutdown');
        if (this.deps.store) {
          // The record stays `queued`/`rendered`: the next process finishes or expires it, so no note now.
          this.settle(entry, 'interrupted', { delivery: 'not_started', resumable: true }, false);
          return;
        }
        if (!this.settle(entry, 'interrupted', { delivery: 'not_started' })) return;
        const note = imageNote(entry.request.kind, entry.request.language, 'interrupted', entry.request.label);
        const budget = deadlineAfter(budgetMs, () => new Error('shutdown notice budget over'));
        await Promise.race([entry.request.notify(note), budget.promise]).catch((err: unknown) =>
          imageLogger.warn({ err, kind: entry.request.kind }, 'Image delivery: shutdown note not sent'),
        );
        budget.clear();
      }),
    );
    // A write the store still refuses gets one last synchronous try: after this process is gone, a row that looks
    // unfinished would be resumed or expired again (a superseded picture sent after the newer one).
    // Stops at the first refusal: SQLite has then already waited its whole busy timeout (5 s) on this thread, and the
    // shutdown deadline is 8 s.
    for (const entry of [...this.unrecordedEntries]) if (!this.tryRecord(entry)) break;
  }

  /** Writes a rebuild to the store before its render starts, so a restart resumes the rebuilt job. A failed write only costs that. */
  private recordRebuild(entry: Entry): void {
    try {
      this.deps.store?.rebuilt(
        entry.id,
        { jobJson: JSON.stringify(entry.job), payloadHash: entry.payload, rebuilds: entry.rebuilds },
        this.now(),
      );
    } catch (err) {
      imageLogger.warn(
        { err, kind: entry.request.kind },
        'Image delivery: the rebuild could not be recorded, a restart would resume the earlier render',
      );
    }
  }

  private isStale(entry: Entry): boolean {
    const { dataOwner } = entry.request;
    if (dataOwner === undefined) return false;
    const changedAt = dataOwner === 'group' ? this.lastWriteSeq : (this.writeSeqByUser.get(dataOwner) ?? 0);
    return changedAt > entry.builtAtSeq;
  }

  private async renderOnce(entry: Entry): Promise<Buffer> {
    const remaining = entry.deadline - this.now();
    const elapsed = () => this.now() - entry.startedAt;
    const cut = deadlineAfter(remaining, () => new RenderTimeoutError(elapsed(), this.boundMs));
    const rendering = this.deps.renderer.renderDirect(entry.job, {
      timeoutMs: remaining,
      signal: entry.abort.signal,
      jobId: entry.rebuilds === 0 ? entry.id : `${entry.id}-r${entry.rebuilds}`,
    });
    rendering.catch(() => {});
    try {
      return await Promise.race([rendering, cut.promise]);
    } catch (err) {
      // Our own bound won the race (or the renderer timed out): withdraw the job from the queue.
      if (err instanceof RenderTimeoutError) entry.abort.abort();
      throw err;
    } finally {
      cut.clear();
    }
  }

  private async renderFresh(entry: Entry): Promise<Buffer> {
    const png = await this.renderOnce(entry);
    if (entry.cancelled || !this.isStale(entry)) return png;
    // The calendar changed while this picture rendered; the text the user got already says the new state.
    // A finished picture is worth more than none: the rebuild only runs with a realistic budget left and
    // any failure of it (not a cancel) falls back to the picture already rendered.
    if (entry.deadline - this.now() < REBUILD_MIN_BUDGET_MS) {
      imageLogger.info(
        { kind: entry.request.kind },
        'Image delivery: data changed but no time to rebuild, sending as rendered',
      );
      return png;
    }
    imageLogger.info({ kind: entry.request.kind }, 'Image delivery: data changed while rendering, rebuilding once');
    const previous = { job: entry.job, payload: entry.payload };
    try {
      const rebuilt = { ...entry.request.buildJob(), expiresAt: entry.deadline };
      entry.builtAtSeq = this.seq;
      const rebuiltPayload = payloadOf(rebuilt);
      if (rebuiltPayload === entry.payload) {
        // The write touched nothing this picture shows: the finished render is already the current one.
        imageLogger.info({ kind: entry.request.kind }, 'Image delivery: data unchanged by the write, no rebuild');
        return png;
      }
      entry.rebuilds++;
      entry.job = rebuilt;
      // From here the picture on its way shows the new data: the same request again is this delivery.
      entry.payload = rebuiltPayload;
      this.recordRebuild(entry);
      return await this.renderOnce(entry);
    } catch (err) {
      entry.job = previous.job;
      entry.payload = previous.payload;
      if (entry.cancelled || err instanceof RenderAbortedError) throw err;
      if (err instanceof RenderTimeoutError) {
        // The fallback absorbs it (the user still gets the earlier picture), but the slow host is still the owner's to hear about.
        reportTimeout({
          kind: 'render',
          elapsedMs: this.now() - entry.startedAt,
          limitMs: this.boundMs,
          recovered: true,
        });
      }
      imageLogger.warn(
        { err, kind: entry.request.kind },
        'Image delivery: the rebuild failed, sending the picture as rendered',
      );
      return png;
    }
  }

  private async run(entry: Entry): Promise<void> {
    const { request } = entry;
    try {
      const png = await this.renderFresh(entry);
      if (entry.cancelled) throw new RenderAbortedError();
      this.deps.store?.advance(entry.id, 'rendered', this.now());
      // Recorded BEFORE the upload starts: a process killed from here on leaves `sending`, which the next
      // start reads as "may have landed" and never retries. It is also the claim on the send: a row another
      // attempt already claimed, or that recovery settled meanwhile, is not uploaded a second time.
      if (this.deps.store && !this.deps.store.advance(entry.id, 'sending', this.now())) {
        this.settle(entry, 'claimed_elsewhere', { delivery: 'not_started' }, false);
        return;
      }
      entry.phase = 'sending';
      const sending = request.send(png);
      sending.catch(() => {});
      const cut = deadlineAfter(this.sendBoundMs, () => new SendTimeoutError(this.sendBoundMs));
      let messageId: number;
      try {
        messageId = await Promise.race([sending, cut.promise]);
      } finally {
        cut.clear();
      }
      this.settle(entry, 'delivered', { messageId });
    } catch (err) {
      await this.fail(entry, err);
    }
  }

  private async fail(entry: Entry, err: unknown): Promise<void> {
    const elapsedMs = this.now() - entry.startedAt;
    if (entry.cancelled === 'superseded') {
      this.settle(entry, 'superseded', {});
      return;
    }
    if (entry.cancelled === 'shutdown') return; // close() logged and told the user
    if (err instanceof SendTimeoutError || err instanceof RenderTimeoutError) {
      await this.failTimedOut(entry, err, elapsedMs);
      return;
    }
    // A typed agenda-image error is thrown before any upload starts, so the picture did not land.
    const typed = agendaImageErrorMessage(err) !== undefined;
    if (entry.phase === 'sending' && !typed && !uploadRefused(err)) {
      await this.failUncertain(entry, err);
      return;
    }
    await this.failForGood(entry, err, elapsedMs);
  }

  /** A bound ran out: the render's (the picture did not come) or the upload's (it may still land). */
  private async failTimedOut(
    entry: Entry,
    err: SendTimeoutError | RenderTimeoutError,
    elapsedMs: number,
  ): Promise<void> {
    const { request } = entry;
    if (err instanceof SendTimeoutError) {
      // The upload may still land: the note does not say it did not, and the owner's repair flow hears of it.
      if (!this.settle(entry, 'timed_out', { phase: 'send', delivery: 'unknown' })) return;
      reportTimeout({ kind: 'render', elapsedMs, limitMs: this.sendBoundMs, recovered: false });
      await this.tell(entry, imageNote(request.kind, request.language, 'uncertain', request.label), false);
      return;
    }
    if (!this.settle(entry, 'timed_out', { phase: 'render' })) return;
    reportTimeout({ kind: 'render', elapsedMs, limitMs: this.boundMs, recovered: false });
    await this.tell(entry, imageNote(request.kind, request.language, 'timedOut', request.label));
  }

  /**
   * The upload was started and ended in an error that does not say Telegram refused it: the picture may have
   * landed. Never a note that says it did not, never a retry; the user is told it may not have arrived (the answer
   * may have been only this picture) and the owner's repair flow hears of it.
   */
  private async failUncertain(entry: Entry, err: unknown): Promise<void> {
    const { request } = entry;
    const errorName = err instanceof Error ? err.name : typeof err;
    if (!this.settle(entry, 'unknown', { delivery: 'unknown', errorName })) return;
    this.reportUncertain({ kind: request.kind, job_type: entry.job.type, created_at: entry.startedAt }, this.now());
    await this.tell(entry, imageNote(request.kind, request.language, 'uncertain', request.label), false);
  }

  /** The picture did not land: one note that fits the cause, and an alert only for what is the bot's own defect. */
  private async failForGood(entry: Entry, err: unknown, elapsedMs: number): Promise<void> {
    const { request } = entry;
    const errorName = err instanceof Error ? err.name : typeof err;
    const tooLarge = agendaImageTooLarge(err);
    const permanent = permanentRefusal(err);
    if (!this.settle(entry, 'failed', { errorName, expected: tooLarge || permanent })) return;
    if (tooLarge) {
      // The picture is over a size limit (too tall, too big): the user must change the request, no incident.
      // Any other typed error (an invalid PNG, no document sender) is a defect and goes on to the alert below.
      // The raw message is English and internal; the user gets the localized note.
      await this.tell(entry, imageNote(request.kind, request.language, 'undeliverable', request.label));
      return;
    }
    if (permanent) {
      // Asking again fails the same way: the note says so instead of offering it, the owner's repair flow gets nothing to investigate.
      imageLogger.warn({ err, kind: request.kind, jobType: entry.job.type }, 'Image delivery refused for good');
      await this.tell(entry, imageNote(request.kind, request.language, 'refused', request.label));
      return;
    }
    imageLogger.error({ err, kind: request.kind, jobType: entry.job.type }, 'Image delivery failed');
    try {
      this.deps.reportFailure?.({ kind: request.kind, jobType: entry.job.type, errorName, elapsedMs });
    } catch (reportErr) {
      imageLogger.error({ err: reportErr }, 'Image delivery failure could not be reported');
    }
    await this.tell(entry, imageNote(request.kind, request.language, 'failed', request.label));
  }

  /**
   * The one note to the user, bounded like the upload: a Telegram call that hangs or sleeps through a flood wait
   * must not hold the delivery. `claim` is the store's once-only claim on the note of a failed/expired row; an
   * uncertain upload ends `unknown`, which recovery never notes, so its single note is guarded by `settle` alone.
   */
  private async tell(entry: Entry, text: string, claim = true): Promise<void> {
    const bound = deadlineAfter(this.sendBoundMs, () => new SendTimeoutError(this.sendBoundMs));
    try {
      if (this.deps.store && claim) {
        if (entry.recordFailed)
          entry.noteUnclaimed = true; // claimed when the end of the delivery is finally written
        else if (!this.deps.store.markNoteSent(entry.id)) return; // another path already owns the note
      }
      const sending = entry.request.notify(text);
      sending.catch(() => {});
      await Promise.race([sending, bound.promise]);
    } catch (err) {
      imageLogger.warn({ err, kind: entry.request.kind }, 'Image delivery: the failure note could not be sent');
    } finally {
      bound.clear();
    }
  }

  /** Logs the one outcome of the delivery (never user text) and records it. False when it was already settled. */
  private settle(entry: Entry, outcome: ImageDeliveryOutcome, details: ImageOutcomeDetails, persist = true): boolean {
    if (entry.settled) return false;
    entry.settled = true;
    const at = this.now();
    this.logOutcome(
      outcome,
      {
        chat_id: entry.request.chatId,
        kind: entry.request.kind,
        job_type: entry.job.type,
        created_at: entry.startedAt,
      },
      at,
      details,
    );
    if (persist && this.deps.store) {
      const messageId = typeof details.messageId === 'number' ? details.messageId : undefined;
      try {
        this.deps.store.finish(entry.id, storedState(outcome, details), at, messageId);
      } catch (err) {
        // Bookkeeping must not stop the user from being told (or the picture from counting as delivered).
        entry.recordFailed = true;
        entry.unrecorded = { state: storedState(outcome, details), at, messageId };
        this.unrecordedEntries.add(entry);
        reportIfDatabaseBusy(err);
        imageLogger.error({ err, kind: entry.request.kind }, 'Image delivery: the outcome could not be recorded');
        this.scheduleRecord(entry, 1);
      }
    }
    return true;
  }

  /**
   * Writes an outcome the store refused (a locked database) once more, so a restart does not find the row still
   * `queued` and send, expire or alert the same picture a second time. A note already sent meanwhile is claimed as
   * soon as the row can carry the claim. Each step is cleared only once it is done, so a refusal in the claim is
   * tried again as the claim alone. False when the store still refuses.
   */
  private tryRecord(entry: Entry): boolean {
    try {
      const { unrecorded } = entry;
      if (unrecorded) {
        this.deps.store?.finish(entry.id, unrecorded.state, unrecorded.at, unrecorded.messageId);
        entry.unrecorded = undefined;
        entry.recordFailed = false;
      }
      if (entry.noteUnclaimed) {
        this.deps.store?.markNoteSent(entry.id);
        entry.noteUnclaimed = false;
      }
      this.unrecordedEntries.delete(entry);
      return true;
    } catch (err) {
      reportIfDatabaseBusy(err);
      return false;
    }
  }

  private scheduleRecord(entry: Entry, attempt: number): void {
    this.schedule(() => {
      if (this.tryRecord(entry)) return;
      if (attempt < RECORD_RETRIES) this.scheduleRecord(entry, attempt + 1);
      else imageLogger.error({ kind: entry.request.kind }, 'Image delivery: the outcome was never recorded');
    }, RECORD_RETRY_MS * attempt);
  }

  private schedule(fn: () => void, delayMs: number): void {
    if (this.deps.schedule) this.deps.schedule(fn, delayMs);
    else setTimeout(fn, delayMs).unref();
  }

  private logOutcome(
    outcome: ImageDeliveryOutcome,
    row: { chat_id: number; kind: string; job_type: string; created_at: number },
    at: number,
    details: ImageOutcomeDetails,
  ): void {
    imageLogger.info(
      {
        outcome,
        kind: row.kind,
        jobType: row.job_type,
        chatId: row.chat_id,
        elapsedMs: at - row.created_at,
        ...details,
      },
      'Image delivery outcome',
    );
  }
}
