import { Blob as BufferBlob } from 'node:buffer';
// Shared lossless PNG delivery policy for command, callback, and AI render transports.
export class AgendaImageError extends Error {}

export const AGENDA_ALLOCATION_ERROR =
  'Agenda image is too large for the screenshot allocation limit. Choose a shorter date range.';

export function agendaImageErrorMessage(error: unknown): string | undefined {
  // BullMQ transports the worker failure message, but not its custom Error subclass.
  if (error instanceof AgendaImageError || (error instanceof Error && error.message === AGENDA_ALLOCATION_ERROR))
    return error.message;
  return undefined;
}

export async function sendAgendaImage<T>(
  file: File,
  transport: {
    language?: string;
    sendPhoto?: (file: File) => Promise<T>;
    sendDocument?: (file: File, options: { caption: string }) => Promise<T>;
  },
): Promise<T> {
  if (file.size > 50 * 1024 * 1024)
    throw new AgendaImageError('Agenda PNG exceeds the 50 MB document limit. Choose a shorter date range.');
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
    if (!transport.sendPhoto) throw new AgendaImageError('Photo delivery is unavailable.');
    return transport.sendPhoto(file);
  }
  if (!transport.sendDocument)
    throw new AgendaImageError('Agenda requires PNG document delivery, but document delivery is unavailable.');
  return transport.sendDocument(file, {
    caption:
      transport.language === 'ru'
        ? 'Это расписание превышает ограничения для фото. Полная картинка отправлена PNG-файлом без обрезки данных.'
        : 'This agenda exceeds Telegram photo limits. The complete PNG is attached as a lossless document.',
  });
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
    throw new AgendaImageError(AGENDA_ALLOCATION_ERROR);
  }
  const scale = width * height * density * density > maxPixels ? 'css' : 'device';
  const effectiveDensity = scale === 'css' ? 1 : density;
  return { scale, width: Math.round(width * effectiveDensity), height: Math.round(height * effectiveDensity) } as const;
}
