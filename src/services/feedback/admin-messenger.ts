import { t, toLang } from '../../config/constants.ts';

export function formatAdminReply(adminText: string, threadSubject: string, lang: string): string {
  return `${t(toLang(lang)).callbackErrors.adminReplyHeader(threadSubject)}\n\n${adminText}`;
}

export async function sendAdminReplyToUser(
  sendMessage: (chatId: number, text: string) => Promise<void>,
  userId: number,
  adminText: string,
  threadSubject: string,
  lang: string,
): Promise<void> {
  await sendMessage(userId, formatAdminReply(adminText, threadSubject, lang));
}
