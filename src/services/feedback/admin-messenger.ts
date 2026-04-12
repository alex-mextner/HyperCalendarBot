export function formatAdminReply(adminText: string, threadSubject: string): string {
  return `💬 Ответ разработчика (${threadSubject}):\n\n${adminText}`;
}

export async function sendAdminReplyToUser(
  sendMessage: (chatId: number, text: string) => Promise<void>,
  userId: number,
  adminText: string,
  threadSubject: string,
): Promise<void> {
  await sendMessage(userId, formatAdminReply(adminText, threadSubject));
}
