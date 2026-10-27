// src/bot/handlers/message/telegram-api.ts
// Raw Bot API access the message handler needs outside gramio: the API base URL and file download.

import { z } from 'zod';

export const TG_API = 'https://api.telegram.org';

export async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer> {
  const metaRes = await fetch(`${TG_API}/bot${botToken}/getFile?file_id=${fileId}`);
  const tgFileSchema = z.object({
    ok: z.boolean(),
    result: z.object({ file_path: z.string() }).optional(),
  });
  const meta = tgFileSchema.parse(await metaRes.json());
  if (!meta.ok || !meta.result?.file_path) {
    throw new Error(`Failed to get file path from Telegram: ${JSON.stringify(meta)}`);
  }
  const fileRes = await fetch(`${TG_API}/file/bot${botToken}/${meta.result.file_path}`);
  if (!fileRes.ok) throw new Error(`Failed to download file: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}
