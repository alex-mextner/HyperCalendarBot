export async function sendAdminReplyToUser(
  sendMessage: (chatId: number, text: string) => Promise<void>,
  userId: number,
  adminText: string,
  threadSubject: string,
): Promise<void> {
  const text = `💬 Ответ разработчика (${threadSubject}):\n\n${adminText}`;
  await sendMessage(userId, text);
}
