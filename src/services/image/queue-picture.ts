// The one way a slash command, a button or an invitation notice sends a calendar picture: it QUEUES the
// picture on ImageDelivery and returns, so the handler never waits for a render. The text answer has
// already been sent by the caller; the picture arrives later as its own message.
//
// Why: the render queue shares a CPU-bound host (renders took 73-80 s on 2026-11-01), so a handler that
// awaited the render held its update (and, for buttons, the user's spinner) for as long as the host was
// slow, and a timeout lost the picture with only a log line. ImageDelivery owns the rest: dedupe of a
// repeated command or tap, the durable record, the restart reconcile, ONE honest note on failure or
// expiry and reportTimeout({kind: 'render'}) for the owner's repair flow.
import { t } from '../../config/constants.ts';
import { sendAgendaImage } from '../../utils/agenda-image.ts';
import { imageLogger } from '../../utils/logger.ts';
import type { ImageRenderJob } from '../../worker/image-render.queue.ts';
import type { ImageDelivery, ImageEnqueueResult, ImageKind } from './image-delivery.ts';

export interface PictureRequest {
  chatId: number;
  language: 'ru' | 'en';
  kind: ImageKind;
  /** What the user asked for (a date, a week, a month): shown only in that user's own failure note. */
  label: string;
  /** The same slot shows the same thing at different times: kind + target + whose calendar. */
  slot: string;
  /** The Telegram message id (command) or callback query id (button): half of the deterministic delivery id. */
  requestId: number | string;
  /** Whose calendar the picture shows, so a write meanwhile rebuilds it from the current data. */
  dataOwner?: number | 'group';
  filename: string;
  /** Reads the CURRENT data and builds the render job; called again once if the calendar changes while it renders. */
  buildJob(): ImageRenderJob;
  /** Each returns the Telegram message id of what it sent. */
  sendPhoto(file: File): Promise<number>;
  sendDocument?(file: File, options: { caption: string }): Promise<number>;
  /** What the user is told when the chat already has too many pictures pending; default: try again a little later. */
  busyNote?: string;
  /** What the user is told when the job cannot even be built; default points at the text answer above the picture, so a picture with no text version supplies its own. */
  failureNote?: string;
  /** Sends a short note to the same chat. */
  notify(text: string): Promise<unknown>;
  /** Runs after the picture is delivered (the best-effort pin); must not throw. */
  onSent?(messageId: number): void;
}

async function say(request: PictureRequest, text: string): Promise<void> {
  try {
    await request.notify(text);
  } catch (err) {
    imageLogger.warn({ err, kind: request.kind }, 'Picture note could not be sent');
  }
}

/**
 * Queues the picture and returns once it is queued. `duplicate` (the same picture is already on its
 * way) and `closed` (the bot is shutting down) are silent; `busy` and a job that cannot even be built
 * get one honest note, because nothing is on its way.
 */
export async function queuePicture(delivery: ImageDelivery, request: PictureRequest): Promise<ImageEnqueueResult> {
  let result: ImageEnqueueResult;
  try {
    result = delivery.enqueue({
      chatId: request.chatId,
      language: request.language,
      kind: request.kind,
      label: request.label,
      slot: request.slot,
      requestId: request.requestId,
      dataOwner: request.dataOwner,
      buildJob: request.buildJob,
      send: async (png) => {
        const file = new File([png], request.filename, { type: 'image/png' });
        const messageId = await sendAgendaImage(file, {
          language: request.language,
          sendPhoto: request.sendPhoto,
          sendDocument: request.sendDocument,
        });
        request.onSent?.(messageId);
        return messageId;
      },
      notify: request.notify,
    });
  } catch (err) {
    imageLogger.error({ err, kind: request.kind }, 'Picture job could not be built');
    await say(request, request.failureNote ?? t(request.language).callbackErrors.imageGenerationFailed);
    return { status: 'closed' };
  }
  if (result.status === 'busy') await say(request, request.busyNote ?? t(request.language).aiTools.meta.imageBusy);
  return result;
}
