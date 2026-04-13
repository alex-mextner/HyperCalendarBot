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
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  /** Guard against concurrent lazy placeholder creation in noPlaceholder mode */
  private creatingPlaceholder = false;

  constructor(
    private sender: TelegramSender,
    private chatId: number,
    private lang: string = 'en',
    opts?: { userTranscript?: string; existingMessageId?: number; noPlaceholder?: boolean },
  ) {
    this.userTranscript = opts?.userTranscript;
    this.messageId = opts?.existingMessageId ?? null;
    this.noPlaceholder = opts?.noPlaceholder ?? false;
    this.startTypingLoop();
  }

  private startTypingLoop(): void {
    this.sender.sendChatAction?.(this.chatId, 'typing').catch(() => {});
    this.typingInterval = setInterval(() => {
      this.sender.sendChatAction?.(this.chatId, 'typing').catch(() => {});
    }, 4000);
  }

  private stopTypingLoop(): void {
    if (this.typingInterval) {
      clearInterval(this.typingInterval);
      this.typingInterval = null;
    }
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

  /** Clear all accumulated state for retry after validation rejection */
  reset(): void {
    this.text = '';
    this.plainResponseText = '';
    this.intermediateChunks = [];
    this.lastFlushedLength = 0;
    this.toolLabel = null;
    this.toolLines = [];
    this.pendingIndicators = [];
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
      // Guard: another concurrent flush is already creating the placeholder.
      // Skip this flush — the text will be picked up by the next one.
      if (this.creatingPlaceholder) return;
      this.creatingPlaceholder = true;
      try {
        // Lazy: materialize the placeholder now that we have substantial content to show
        const result = await this.sender.sendMessage(this.chatId, '⏳');
        this.messageId = result.message_id;
      } finally {
        this.creatingPlaceholder = false;
      }
    }

    let displayText = markdownToHtml(this.text) || '⏳';
    // Append "..." while still generating — removed on finalize
    if (displayText !== '⏳') {
      displayText += '...';
    }
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
      aiLogger.error({ error: errStr }, 'Failed to edit stream message');
    }
  }

  async finalize(): Promise<void> {
    this.stopTypingLoop();
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
      // Build expandable blockquote with ALL intermediate reasoning + tools.
      // Cap execution log so the total message fits in one Telegram message —
      // splitting into multiple messages confuses users and can break HTML tags.
      finalText = finalResponse;
      if (this.intermediateChunks.length > 0) {
        const header = this.lang === 'ru' ? '⚙️ <b>Ход выполнения</b>' : '⚙️ <b>Execution log</b>';
        let body = this.intermediateChunks.join('\n');
        // blockquote wrapper + header + separators ≈ 60 chars overhead
        const overhead = `<blockquote expandable>${header}\n</blockquote>\n\n`.length;
        const maxBodyLen = MAX_MESSAGE_LENGTH - finalResponse.length - overhead;
        if (maxBodyLen > 0 && body.length > maxBodyLen) {
          body = `${body.slice(0, maxBodyLen - 1)}…`;
        }
        if (maxBodyLen > 0) {
          finalText = `<blockquote expandable>${header}\n${body}</blockquote>\n\n${finalResponse}`;
        }
        // If maxBodyLen <= 0, response alone fills the message — skip blockquote entirely
      }
    }

    const chunks = splitMessage(finalText, MAX_MESSAGE_LENGTH);
    this.text = chunks[0]!;
    this.lastFlushedLength = 0;

    // First chunk: edit existing placeholder or send fresh message.
    // ALWAYS use parse_mode: 'HTML' — our HTML is well-formed. If Telegram
    // rejects it (rate limit, transient error), log and move on. Never
    // downgrade to no parse_mode — that shows raw tags to the user.
    if (this.messageId) {
      try {
        await this.sender.editMessageText(this.chatId, this.messageId, this.text, 'HTML');
      } catch (err) {
        aiLogger.error({ err }, 'Finalize edit failed');
      }
    } else if (this.text.trim()) {
      try {
        const result = await this.sender.sendMessage(this.chatId, this.text, 'HTML');
        this.messageId = result.message_id;
      } catch (err) {
        aiLogger.error({ err }, 'Finalize send failed');
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

  /**
   * Last-resort error delivery: if finalize() fails or was never called,
   * send a plain error message directly so the user always sees feedback.
   */
  async sendErrorFallback(errorText: string): Promise<void> {
    this.stopTypingLoop();
    try {
      if (this.messageId) {
        await this.sender.editMessageText(this.chatId, this.messageId, errorText);
      } else {
        await this.sender.sendMessage(this.chatId, errorText);
      }
    } catch (err) {
      aiLogger.error({ err }, 'Error fallback delivery also failed');
      // Last attempt: plain send without editing
      if (this.messageId) {
        await this.sender.sendMessage(this.chatId, errorText).catch(() => {});
      }
    }
  }

  async discard(): Promise<void> {
    this.stopTypingLoop();
    if (this.messageId) {
      try {
        await this.sender.deleteMessage?.(this.chatId, this.messageId);
      } catch {
        /* ignore — message may already be gone */
      }
    }
  }

  /**
   * Drop any buffered content (current text, intermediate chunks, tool lines)
   * without touching Telegram. Used when the response validator rejects a
   * tool-less answer and the agent wants to discard it and retry cleanly —
   * the rejected text must NOT appear in the final execution log.
   */
  resetBuffers(): void {
    this.text = '';
    this.lastFlushedLength = 0;
    this.toolLabel = null;
    this.toolLines = [];
    this.pendingIndicators = [];
    this.intermediateChunks = [];
    this.plainResponseText = '';
  }

  getMessageId(): number | null {
    return this.messageId;
  }
}
