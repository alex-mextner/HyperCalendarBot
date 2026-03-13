import { logger } from '../../utils/logger.ts';
import type { TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-stream' });

const TOOL_LABELS: Record<string, string> = {
  get_events: '📅 Смотрю события...',
  create_event: '✏️ Создаю событие...',
  update_event: '✏️ Обновляю событие...',
  delete_event: '🗑 Удаляю событие...',
  get_free_slots: '🔍 Ищу свободное время...',
  search_events: '🔍 Ищу события...',
  set_reminder: '⏰ Ставлю напоминание...',
  get_holidays: '🎉 Проверяю праздники...',
  get_user_settings: '⚙️ Загружаю настройки...',
  update_user_settings: '⚙️ Обновляю настройки...',
};

const MIN_FLUSH_DELTA = 20;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private messageId: number | null = null;
  private text = '';
  private lastFlushedLength = 0;
  private toolLabel: string | null = null;

  constructor(
    private sender: TelegramSender,
    private chatId: number,
  ) {}

  async init(): Promise<void> {
    const result = await this.sender.sendMessage(this.chatId, '⏳');
    this.messageId = result.message_id;
  }

  appendText(chunk: string): void {
    this.text += chunk;
  }

  getText(): string {
    return this.text;
  }

  setToolLabel(toolName: string): void {
    this.toolLabel = TOOL_LABELS[toolName] ?? `🔧 ${toolName}...`;
  }

  clearToolLabel(): void {
    this.toolLabel = null;
  }

  async flush(force: boolean): Promise<void> {
    if (!this.messageId) return;

    const delta = this.text.length - this.lastFlushedLength;

    if (!force && delta < MIN_FLUSH_DELTA) {
      return;
    }

    if (delta === 0 && !this.toolLabel) return;

    let displayText = this.text || '⏳';
    if (this.toolLabel) {
      displayText = displayText ? `${displayText}\n\n_${this.toolLabel}_` : `_${this.toolLabel}_`;
    }

    if (displayText.length > MAX_MESSAGE_LENGTH) {
      displayText = `${displayText.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
    }

    try {
      await this.sender.editMessageText(this.chatId, this.messageId, displayText);
      this.lastFlushedLength = this.text.length;
    } catch (error) {
      const errStr = String(error);
      if (errStr.includes('429') || errStr.includes('Too Many Requests')) {
        aiLogger.warn('Telegram rate limit hit, will retry on next flush');
        return;
      }
      if (errStr.includes('message is not modified')) {
        return;
      }
      aiLogger.error({ error: errStr }, 'Failed to edit stream message');
    }
  }

  async finalize(): Promise<void> {
    this.toolLabel = null;
    if (!this.text) {
      this.text = '...';
    }
    this.lastFlushedLength = 0;
    await this.flush(true);
  }

  getMessageId(): number | null {
    return this.messageId;
  }
}
