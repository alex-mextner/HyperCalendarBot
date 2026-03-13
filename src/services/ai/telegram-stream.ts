import { logger } from '../../utils/logger.ts';
import type { TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-stream' });

const TOOL_LABELS: Record<string, Record<string, string>> = {
  get_events: { en: '📅 Looking up events...', ru: '📅 Смотрю события...' },
  create_event: { en: '✏️ Creating event...', ru: '✏️ Создаю событие...' },
  update_event: { en: '✏️ Updating event...', ru: '✏️ Обновляю событие...' },
  delete_event: { en: '🗑 Deleting event...', ru: '🗑 Удаляю событие...' },
  get_free_slots: { en: '🔍 Finding free time...', ru: '🔍 Ищу свободное время...' },
  search_events: { en: '🔍 Searching events...', ru: '🔍 Ищу события...' },
  set_reminder: { en: '⏰ Setting reminder...', ru: '⏰ Ставлю напоминание...' },
  get_holidays: { en: '🎉 Checking holidays...', ru: '🎉 Проверяю праздники...' },
  get_user_settings: { en: '⚙️ Loading settings...', ru: '⚙️ Загружаю настройки...' },
  update_user_settings: { en: '⚙️ Updating settings...', ru: '⚙️ Обновляю настройки...' },
};

const MIN_FLUSH_DELTA = 20;
const FLUSH_INTERVAL_MS = 3000;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private messageId: number | null = null;
  private text = '';
  private lastFlushedLength = 0;
  private lastFlushTime = 0;
  private toolLabel: string | null = null;

  constructor(
    private sender: TelegramSender,
    private chatId: number,
    private lang: string = 'en',
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
    const labels = TOOL_LABELS[toolName];
    this.toolLabel = labels?.[this.lang] ?? labels?.en ?? `🔧 ${toolName}...`;
  }

  clearToolLabel(): void {
    this.toolLabel = null;
  }

  async flush(force: boolean): Promise<void> {
    if (!this.messageId) return;

    const delta = this.text.length - this.lastFlushedLength;
    const now = Date.now();
    const timeSinceFlush = now - this.lastFlushTime;

    if (!force && (delta < MIN_FLUSH_DELTA || timeSinceFlush < FLUSH_INTERVAL_MS)) {
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
      await this.sender.editMessageText(this.chatId, this.messageId, displayText, 'Markdown');
      this.lastFlushedLength = this.text.length;
      this.lastFlushTime = Date.now();
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
