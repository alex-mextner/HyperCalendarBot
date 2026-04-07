import { logger } from '../../utils/logger.ts';
import { escapeHtml, markdownToHtml, splitMessage } from '../../utils/telegram.ts';
import type { TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-stream' });

const TOOL_LABELS: Record<string, Record<string, string>> = {
  get_events: { en: '📅 Events', ru: '📅 События' },
  create_event: { en: '✏️ Create event', ru: '✏️ Создаю событие' },
  update_event: { en: '✏️ Update event', ru: '✏️ Обновляю событие' },
  delete_event: { en: '🗑 Delete event', ru: '🗑 Удаляю событие' },
  get_free_slots: { en: '🔍 Free time', ru: '🔍 Свободное время' },
  search_events: { en: '🔍 Search', ru: '🔍 Поиск' },
  set_reminder: { en: '⏰ Reminder', ru: '⏰ Напоминание' },
  get_holidays: { en: '🎉 Holidays', ru: '🎉 Праздники' },
  get_user_settings: { en: '⚙️ Settings', ru: '⚙️ Настройки' },
  update_user_settings: { en: '⚙️ Settings', ru: '⚙️ Настройки' },
  find_user: { en: '👤 Find user', ru: '👤 Ищу пользователя' },
  send_invitation: { en: '📨 Invitation', ru: '📨 Приглашение' },
  get_upcoming: { en: '📅 Upcoming', ru: '📅 Ближайшие' },
  get_event: { en: '📅 Event', ru: '📅 Событие' },
  get_reminders: { en: '⏰ Reminders', ru: '⏰ Напоминания' },
  snooze_event: { en: '⏰ Snooze', ru: '⏰ Откладываю' },
  share_event: { en: '📤 Share', ru: '📤 Шаринг' },
  get_invitation_status: { en: '📨 Status', ru: '📨 Статус' },
};

const MAX_ARG_LENGTH = 50;

function formatToolInput(input: { [key: string]: unknown }): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    let display = typeof value === 'string' ? value : JSON.stringify(value);
    if (display.length > MAX_ARG_LENGTH) {
      display = `${display.slice(0, MAX_ARG_LENGTH - 1)}…`;
    }
    parts.push(`${key}: ${escapeHtml(display)}`);
  }
  return parts.join(', ');
}

const MIN_FLUSH_DELTA = 20;
const FLUSH_INTERVAL_MS = 3000;
const MAX_MESSAGE_LENGTH = 4000;

export class TelegramStreamWriter {
  private messageId: number | null = null;
  private text = '';
  private lastFlushedLength = 0;
  private lastFlushTime = 0;
  private toolLabel: string | null = null;
  private toolLines: string[] = [];
  private pendingIndicators: string[] = [];
  private intermediateChunks: string[] = [];
  private plainResponseText = '';
  private userTranscript: string | undefined;
  private noPlaceholder: boolean;

  constructor(
    private sender: TelegramSender,
    private chatId: number,
    private lang: string = 'en',
    opts?: { userTranscript?: string; existingMessageId?: number; noPlaceholder?: boolean },
  ) {
    this.userTranscript = opts?.userTranscript;
    this.messageId = opts?.existingMessageId ?? null;
    this.noPlaceholder = opts?.noPlaceholder ?? false;
  }

  async init(): Promise<void> {
    if (this.messageId !== null) {
      // Reuse existing listening indicator message — already visible in chat
      return;
    }
    if (this.userTranscript !== undefined) {
      // Live call without pre-created message: send transcript header
      const header = escapeHtml(this.userTranscript || '…');
      const result = await this.sender.sendMessage(this.chatId, `📞 👤 ${header}`, 'HTML');
      this.messageId = result.message_id;
      return;
    }
    if (this.noPlaceholder) {
      // Skip sending ⏳ — message will be created on finalize if AI responds
      return;
    }
    const result = await this.sender.sendMessage(this.chatId, '⏳');
    this.messageId = result.message_id;
  }

  /** Clear accumulated text for retry after validation rejection */
  reset(): void {
    this.text = '';
    this.plainResponseText = '';
    this.intermediateChunks = [];
    this.lastFlushedLength = 0;
  }

  appendText(chunk: string): void {
    this.text += chunk;
  }

  tailText(maxLen: number): void {
    if (this.text.length > maxLen) {
      this.text = `\u2026${this.text.slice(-(maxLen - 1))}`;
      this.lastFlushedLength = 0;
    }
  }

  getText(): string {
    return this.plainResponseText || this.text;
  }

  getPlainText(): string {
    return this.plainResponseText;
  }

  setToolLabel(toolName: string, input?: { [key: string]: unknown }): void {
    const labels = TOOL_LABELS[toolName];
    const label = labels?.[this.lang] ?? labels?.en ?? toolName;
    const details = input ? formatToolInput(input) : '';
    const detailsSuffix = details ? `: ${details}` : '';
    this.toolLabel = `<i>${escapeHtml(label)}${detailsSuffix}...</i>`;
    this.pendingIndicators.push(`${escapeHtml(label)}${detailsSuffix}`);
  }

  markToolResult(success: boolean): void {
    if (this.pendingIndicators.length > 0) {
      const indicator = this.pendingIndicators.pop()!;
      const status = success ? '✅' : '❌';
      this.toolLines.push(`${status} <i>${indicator}</i>`);
    }
    this.toolLabel = null;
  }

  clearToolLabel(): void {
    this.toolLabel = null;
  }

  commitIntermediate(): void {
    if (this.text.trim()) {
      this.intermediateChunks.push(escapeHtml(this.text.trim()));
    }
    // Collect completed tool lines into intermediate
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push(this.toolLines.join('\n'));
      this.toolLines = [];
    }
    this.text = '';
    this.lastFlushedLength = 0;
  }

  async flush(force: boolean): Promise<void> {
    const delta = this.text.length - this.lastFlushedLength;
    const timeSinceFlush = Date.now() - this.lastFlushTime;

    // Check content thresholds before creating a placeholder (avoids sending ⏳ for [SKIP])
    if (!force && (delta < MIN_FLUSH_DELTA || timeSinceFlush < FLUSH_INTERVAL_MS)) return;
    if (delta === 0 && !this.toolLabel) return;

    if (!this.messageId) {
      if (!this.noPlaceholder) return;
      // Lazy: materialize the placeholder now that we have substantial content to show
      const result = await this.sender.sendMessage(this.chatId, '⏳');
      this.messageId = result.message_id;
    }

    let displayText = markdownToHtml(this.text) || '⏳';
    if (this.toolLabel) {
      displayText = displayText ? `${displayText}\n\n${this.toolLabel}` : this.toolLabel;
    }

    if (displayText.length > MAX_MESSAGE_LENGTH) {
      displayText = `${displayText.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
    }

    try {
      await this.sender.editMessageText(this.chatId, this.messageId, displayText, 'HTML');
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
      if (errStr.includes("can't parse entities") || errStr.includes('parse')) {
        aiLogger.warn('HTML parse failed, falling back to plain text');
        try {
          await this.sender.editMessageText(this.chatId, this.messageId, this.text || '⏳');
          this.lastFlushedLength = this.text.length;
          this.lastFlushTime = Date.now();
        } catch (retryError) {
          aiLogger.error({ err: retryError }, 'Fallback plain text edit also failed');
        }
        return;
      }
      aiLogger.error({ error: errStr }, 'Failed to edit stream message');
    }
  }

  async finalize(): Promise<void> {
    this.toolLabel = null;
    this.plainResponseText = this.text.trim();

    // Collect any remaining tool lines from the last round
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push(this.toolLines.join('\n'));
      this.toolLines = [];
    }

    const finalResponse = this.plainResponseText ? markdownToHtml(this.text) : '...';

    let finalText: string;
    if (this.userTranscript !== undefined) {
      // Live call: everything in one collapsed blockquote (transcript + tools + bot reply)
      const toolsBlock = this.intermediateChunks.length > 0 ? `\n${this.intermediateChunks.join('\n')}` : '';
      const botReply = finalResponse && finalResponse !== '...' ? `\n🤖 ${finalResponse}` : '';
      finalText = `<blockquote>📞\n👤 ${escapeHtml(this.userTranscript || '…')}${toolsBlock}${botReply}</blockquote>`;
    } else {
      // Build expandable blockquote with ALL intermediate reasoning + tools
      finalText = finalResponse;
      if (this.intermediateChunks.length > 0) {
        const header = this.lang === 'ru' ? '⚙️ <b>Ход выполнения</b>' : '⚙️ <b>Execution log</b>';
        const body = this.intermediateChunks.join('\n');
        finalText = `<blockquote expandable>${header}\n${body}</blockquote>\n\n${finalResponse}`;
      }
    }

    const chunks = splitMessage(finalText, MAX_MESSAGE_LENGTH);
    this.text = chunks[0]!;
    this.lastFlushedLength = 0;

    // First chunk: edit existing placeholder or send fresh message
    if (this.messageId) {
      try {
        await this.sender.editMessageText(this.chatId, this.messageId, this.text, 'HTML');
      } catch {
        try {
          await this.sender.editMessageText(this.chatId, this.messageId, this.text);
        } catch (e) {
          aiLogger.error({ err: e }, 'Finalize edit failed');
        }
      }
    } else if (this.text.trim()) {
      try {
        const result = await this.sender.sendMessage(this.chatId, this.text, 'HTML');
        this.messageId = result.message_id;
      } catch {
        await this.sender.sendMessage(this.chatId, this.text).catch((e: unknown) => {
          aiLogger.error({ err: e }, 'Finalize send failed');
        });
      }
    }

    // Remaining chunks: send as new messages
    for (let i = 1; i < chunks.length; i++) {
      try {
        await this.sender.sendMessage(this.chatId, chunks[i]!, 'HTML');
      } catch {
        await this.sender.sendMessage(this.chatId, chunks[i]!).catch(() => {});
      }
    }
  }

  async discard(): Promise<void> {
    if (this.messageId) {
      try {
        await this.sender.deleteMessage?.(this.chatId, this.messageId);
      } catch {
        /* ignore — message may already be gone */
      }
    }
  }

  getMessageId(): number | null {
    return this.messageId;
  }
}
