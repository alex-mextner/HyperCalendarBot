import { cmdLogger } from './logger.ts';

interface AutoPinDeps {
  pinChatMessage: (chatId: number, messageId: number, options: { disable_notification: boolean }) => Promise<true>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  isGroupChat: boolean;
  groupChatRepo?: {
    findByChatId(chatId: number): { pin_hint_shown: number } | null;
    setPinHintShown(chatId: number): void;
  };
}

export async function autoPin(chatId: number, messageId: number, deps: AutoPinDeps): Promise<void> {
  try {
    await deps.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (error) {
    if (!deps.isGroupChat) {
      cmdLogger.warn({ chatId, err: error }, 'Failed to pin in private chat');
      return;
    }

    // Group chat — check if hint already shown
    if (!deps.groupChatRepo) return;

    const groupChat = deps.groupChatRepo.findByChatId(chatId);
    if (!groupChat || groupChat.pin_hint_shown === 1) return;

    // Show hint once
    deps.groupChatRepo.setPinHintShown(chatId);
    await deps
      .sendMessage(chatId, 'Если дать мне права админа, я буду закреплять актуальный календарь автоматически 📌')
      .catch((err: unknown) => {
        cmdLogger.error({ err: err }, 'Failed to send pin hint');
      });
  }
}
