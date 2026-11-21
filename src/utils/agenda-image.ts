import { Blob as BufferBlob } from 'node:buffer';
import { TelegramError } from 'gramio';
import { imageLogger } from './logger.ts';
// Shared lossless PNG delivery policy for command, callback, and AI render transports.
/** `tooLarge`: the picture is over a limit the user can stay under by asking for less; any other typed error is a defect of the renderer or the transport. */
export class AgendaImageError extends Error {
  constructor(
    message: string,
    readonly tooLarge = false,
  ) {
    super(message);
  }
}

export const AGENDA_ALLOCATION_ERROR =
  'Agenda image is too large for the screenshot allocation limit. Choose a shorter date range.';

export function agendaImageErrorMessage(error: unknown): string | undefined {
  // BullMQ transports the worker failure message, but not its custom Error subclass.
  if (error instanceof AgendaImageError || (error instanceof Error && error.message === AGENDA_ALLOCATION_ERROR))
    return error.message;
  return undefined;
}

/** True for a picture over a size limit (the raster allocation, the 50 MB document), whichever way the error reached us. */
export function agendaImageTooLarge(error: unknown): boolean {
  if (error instanceof AgendaImageError) return error.tooLarge;
  return error instanceof Error && error.message === AGENDA_ALLOCATION_ERROR;
}

/**
 * Telegram refuses a photo it cannot process (`IMAGE_PROCESS_FAILED`, `PHOTO_INVALID_DIMENSIONS`) even when the
 * local limits pass. Only Telegram's own 400 qualifies: it means nothing was sent, so the same PNG as a document
 * is not a replay. Any other error leaves the photo's outcome unknown and propagates. Known limit (#1025): the
 * caller's send bound (`IMAGE_SEND_BOUND_MS`) races this whole call without cancelling it, so a photo that is
 * refused only after the bound fired still starts the document, and both uploads share that one limit.
 */
function photoRejectedByTelegram(error: unknown): error is TelegramError<'sendPhoto'> {
  return (
    error instanceof TelegramError &&
    error.code === 400 &&
    /\b(IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS)\b/.test(error.message)
  );
}

function documentCaption(language: string | undefined, reason: 'oversized' | 'photoRefused'): string {
  if (reason === 'photoRefused')
    return language === 'ru'
      ? 'Telegram не смог обработать это расписание как фото. Полная картинка отправлена PNG-файлом без обрезки данных.'
      : 'Telegram could not process this agenda as a photo. The complete PNG is attached as a lossless document.';
  return language === 'ru'
    ? 'Это расписание превышает ограничения для фото. Полная картинка отправлена PNG-файлом без обрезки данных.'
    : 'This agenda exceeds Telegram photo limits. The complete PNG is attached as a lossless document.';
}

type AgendaTransport<T> = {
  language?: string;
  sendPhoto?: (file: File) => Promise<T>;
  sendDocument?: (file: File, options: { caption: string }) => Promise<T>;
};

async function sendPhotoOrRefusedDocument<T>(
  file: File,
  size: { width: number; height: number },
  transport: AgendaTransport<T>,
): Promise<T> {
  if (!transport.sendPhoto) throw new AgendaImageError('Photo delivery is unavailable.');
  try {
    return await transport.sendPhoto(file);
  } catch (error) {
    if (!transport.sendDocument || !photoRejectedByTelegram(error)) throw error;
    // The 400 never reaches ImageDelivery's failure log or alert, so the refusal is recorded here.
    imageLogger.warn(
      { code: error.code, description: error.message, ...size, bytes: file.size },
      'Photo refused by Telegram, sending as document',
    );
    return transport.sendDocument(file, { caption: documentCaption(transport.language, 'photoRefused') });
  }
}

export async function sendAgendaImage<T>(file: File, transport: AgendaTransport<T>): Promise<T> {
  if (file.size > 50 * 1024 * 1024)
    throw new AgendaImageError('Agenda PNG exceeds the 50 MB document limit. Choose a shorter date range.', true);
  const header = Buffer.from(await BufferBlob.prototype.slice.call(file, 0, 24).arrayBuffer());
  if (
    header.length < 24 ||
    !header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw new AgendaImageError('Agenda renderer returned an invalid PNG.');
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height) throw new AgendaImageError('Agenda PNG has invalid dimensions.');
  if (
    width + height <= 10000 &&
    Math.max(width, height) / Math.min(width, height) <= 20 &&
    file.size <= 10 * 1024 * 1024
  ) {
    return sendPhotoOrRefusedDocument(file, { width, height }, transport);
  }
  if (!transport.sendDocument)
    throw new AgendaImageError('Agenda requires PNG document delivery, but document delivery is unavailable.');
  return transport.sendDocument(file, { caption: documentCaption(transport.language, 'oversized') });
}

/** Plan screenshot allocation before creating a raster. */
export function planAgendaRaster(height: number, density: number) {
  const width = 1080;
  const maxPixels = 24_000_000;
  if (
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isFinite(density) ||
    density < 1 ||
    width * height > maxPixels
  ) {
    throw new AgendaImageError(AGENDA_ALLOCATION_ERROR, true);
  }
  const scale = width * height * density * density > maxPixels ? 'css' : 'device';
  const effectiveDensity = scale === 'css' ? 1 : density;
  return { scale, width: Math.round(width * effectiveDensity), height: Math.round(height * effectiveDensity) } as const;
}
