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
const FINAL_RATE_LIMIT_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null;
}

function retryAfterValueMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value * 1000) : null;
}

function telegramRetryAfterMs(err: unknown): number | null {
  if (!isObject(err)) {
    const match = String(err).match(/retry after (\d+)/i);
    return match ? Number(match[1]) * 1000 : null;
  }

  const directRetryAfter = retryAfterValueMs(err.retry_after);
  if (directRetryAfter !== null) return directRetryAfter;

  const payload = err.payload;
  const payloadRetryAfter = isObject(payload) ? retryAfterValueMs(payload.retry_after) : null;
  if (payloadRetryAfter !== null) return payloadRetryAfter;

  const parameters = err.parameters;
  const parametersRetryAfter = isObject(parameters) ? retryAfterValueMs(parameters.retry_after) : null;
  if (parametersRetryAfter !== null) return parametersRetryAfter;

  const message = typeof err.message === 'string' ? err.message : String(err);
  const match = message.match(/retry after (\d+)/i);
  return match ? Math.max(0, Number(match[1]) * 1000) : null;
}

function isTelegramRateLimit(err: unknown): boolean {
  if (isObject(err) && err.code === 429) return true;
  const message = isObject(err) && typeof err.message === 'string' ? err.message : String(err);
  return message.includes('429') || message.includes('Too Many Requests');
}

async function withTelegramRateLimitRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; attempt <= FINAL_RATE_LIMIT_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (!isTelegramRateLimit(err) || attempt === FINAL_RATE_LIMIT_ATTEMPTS) throw err;

      const retryAfterMs = telegramRetryAfterMs(err) ?? 1000;
      aiLogger.warn({ err, retryAfterMs, attempt }, `${label} rate limited, retrying`);
      if (retryAfterMs > 0) await sleep(retryAfterMs);
    }
  }
  throw new Error(`${label} failed after rate-limit retries`);
}

export class TelegramStreamWriter {
  private messageId: number | null = null;
  private text = '';
  private lastFlushedLength = 0;
  private lastFlushTime = 0;
  private toolLabel: string | null = null;
  private toolLines: string[] = [];
  private pendingIndicators: string[] = [];
  private intermediateChunks: { kind: 'reasoning' | 'tools'; text: string }[] = [];
  private plainResponseText = '';
  private userTranscript: string | undefined;
  private noPlaceholder: boolean;
  private typingInterval: ReturnType<typeof setInterval> | null = null;
  /** Promise for the in-flight lazy placeholder creation (prevents races between flush/finalize) */
  private placeholderPromise: Promise<void> | null = null;
  /** Serializes fire-and-forget flushes so Telegram edits cannot burst concurrently. */
  private flushTail: Promise<void> | null = null;
  private flushSeq = 0;
  /** Telegram flood-wait deadline learned from a streaming edit. Finalize waits for it. */
  private rateLimitedUntil = 0;
  /** Once stream editing hits flood-wait, stop intermediate edits and only deliver final text. */
  private streamRateLimited = false;
  /** Set by discard() so a pending flush knows to delete the message after creation.
   * discard() is only ever called as the terminal action of CalendarBotAgent.run(),
   * immediately followed by `return` — no other method runs on this writer instance
   * afterward. resetDraft()/resetForGuard() deliberately never clear this field: by
   * the time either could run again, the request is already over. */
  private discarded = false;

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

  appendText(chunk: string): void {
    this.text += chunk;
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
      this.intermediateChunks.push({ kind: 'reasoning', text: escapeHtml(this.text.trim()) });
    }
    // Collect completed tool lines into intermediate
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push({ kind: 'tools', text: this.toolLines.join('\n') });
      this.toolLines = [];
    }
    this.text = '';
    this.lastFlushedLength = 0;
  }

  async flush(force: boolean): Promise<void> {
    const previous = this.flushTail;
    const seq = ++this.flushSeq;
    const run = previous ? previous.catch(() => {}).then(() => this.doFlush(force)) : this.doFlush(force);
    this.flushTail = run.finally(() => {
      if (this.flushSeq === seq) {
        this.flushTail = null;
      }
    });
    await run;
  }

  private async doFlush(force: boolean): Promise<void> {
    if (this.streamRateLimited) return;

    const delta = this.text.length - this.lastFlushedLength;
    const timeSinceFlush = Date.now() - this.lastFlushTime;

    // Check content thresholds before creating a placeholder (avoids sending ⏳ for [SKIP])
    if (!force && (delta < MIN_FLUSH_DELTA || timeSinceFlush < FLUSH_INTERVAL_MS)) return;
    if (delta === 0 && !this.toolLabel) return;

    if (!this.messageId) {
      if (!this.noPlaceholder) return;
      // Deduplicate: reuse the in-flight promise if another flush (or finalize)
      // is already creating the placeholder. Without this, concurrent
      // fire-and-forget flushes each create their own ⏳ → multiple messages.
      if (!this.placeholderPromise) {
        this.placeholderPromise = this.sender
          .sendMessage(this.chatId, '⏳')
          .then((result) => {
            this.messageId = result.message_id;
            // discard() ran while we were creating — delete the message and bail
            if (this.discarded) {
              this.sender.deleteMessage?.(this.chatId, this.messageId).catch((err) => {
                aiLogger.warn({ err, chatId: this.chatId, messageId: this.messageId }, 'Post-discard cleanup failed');
              });
            }
          })
          .catch((err) => {
            aiLogger.warn({ err, chatId: this.chatId }, 'Failed to create placeholder message');
          })
          .finally(() => {
            this.placeholderPromise = null;
          });
      }
      await this.placeholderPromise;
      if (!this.messageId || this.discarded) return;
    }

    const flushedLength = this.text.length;
    let displayText = markdownToHtml(this.text) || '⏳';
    // Append "..." while still generating — removed on finalize
    if (displayText !== '⏳') {
      displayText += '...';
    }
    if (this.toolLabel) {
      displayText = displayText ? `${displayText}\n\n${this.toolLabel}` : this.toolLabel;
    }

    if (displayText.length > MAX_MESSAGE_LENGTH) {
      // Truncate at the last safe boundary (newline or space) to avoid slicing
      // inside HTML tags like <i>...</i> — a broken tag makes Telegram reject the edit.
      const slice = displayText.slice(0, MAX_MESSAGE_LENGTH - 3);
      const safeCut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('>'));
      displayText = safeCut > 0 ? `${displayText.slice(0, safeCut + 1)}...` : `${slice}...`;
    }

    try {
      await this.sender.editMessageText(this.chatId, this.messageId, displayText, 'HTML');
      this.lastFlushedLength = flushedLength;
      this.lastFlushTime = Date.now();
    } catch (error) {
      const errStr = String(error);
      if (isTelegramRateLimit(error)) {
        const retryAfterMs = telegramRetryAfterMs(error) ?? 1000;
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + retryAfterMs);
        this.streamRateLimited = true;
        this.lastFlushTime = Date.now();
        aiLogger.warn(
          { err: error, retryAfterMs },
          'Telegram rate limit hit during stream edit, deferring to final edit',
        );
        return;
      }
      if (errStr.includes('message is not modified')) {
        return;
      }
      aiLogger.error({ err: error }, 'Failed to edit stream message');
    }
  }

  async finalize(): Promise<void> {
    this.stopTypingLoop();
    if (this.flushTail) await this.flushTail;
    // Wait for any in-flight placeholder creation from a concurrent flush
    if (this.placeholderPromise) await this.placeholderPromise;
    const rateLimitDelayMs = this.rateLimitedUntil - Date.now();
    if (rateLimitDelayMs > 0) {
      aiLogger.warn({ retryAfterMs: rateLimitDelayMs }, 'Waiting for Telegram rate limit before final edit');
      await sleep(rateLimitDelayMs);
    }
    this.toolLabel = null;
    this.plainResponseText = this.text.trim();

    // Collect any remaining tool lines from the last round
    if (this.toolLines.length > 0) {
      this.intermediateChunks.push({ kind: 'tools', text: this.toolLines.join('\n') });
      this.toolLines = [];
    }

    const finalResponse = this.plainResponseText ? markdownToHtml(this.text) : '...';
    const joinedIntermediate = this.intermediateChunks.map((c) => c.text).join('\n');

    let finalText: string;
    if (this.userTranscript !== undefined) {
      // Live call: everything in one collapsed blockquote (transcript + tools + bot reply)
      const toolsBlock = this.intermediateChunks.length > 0 ? `\n${joinedIntermediate}` : '';
      const botReply = finalResponse && finalResponse !== '...' ? `\n🤖 ${finalResponse}` : '';
      finalText = `<blockquote>📞\n👤 ${escapeHtml(this.userTranscript || '…')}${toolsBlock}${botReply}</blockquote>`;
    } else {
      // Build expandable blockquote with ALL intermediate reasoning + tools.
      // Cap execution log so the total message fits in one Telegram message —
      // splitting into multiple messages confuses users and can break HTML tags.
      finalText = finalResponse;
      if (this.intermediateChunks.length > 0) {
        const header = this.lang === 'ru' ? '⚙️ <b>Ход выполнения</b>' : '⚙️ <b>Execution log</b>';
        let body = joinedIntermediate;
        // blockquote wrapper + header + separators ≈ 60 chars overhead
        const overhead = `<blockquote expandable>${header}\n</blockquote>\n\n`.length;
        const maxBodyLen = MAX_MESSAGE_LENGTH - finalResponse.length - overhead;
        if (maxBodyLen > 0 && body.length > maxBodyLen) {
          // Truncate at a line boundary to avoid breaking HTML tags (<i>...</i>).
          // A naive body.slice() can cut inside a tag, making Telegram reject the message.
          const truncSlice = body.slice(0, maxBodyLen);
          const lastNewline = truncSlice.lastIndexOf('\n');
          body = lastNewline > 0 ? `${body.slice(0, lastNewline)}\n…` : `${truncSlice.slice(0, maxBodyLen - 1)}…`;
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
      const messageId = this.messageId;
      try {
        await withTelegramRateLimitRetry(
          () => this.sender.editMessageText(this.chatId, messageId, this.text, 'HTML'),
          'Finalize edit',
        );
      } catch (err) {
        aiLogger.error({ err }, 'Finalize edit failed');
      }
    } else if (this.text.trim()) {
      try {
        const result = await withTelegramRateLimitRetry(
          () => this.sender.sendMessage(this.chatId, this.text, 'HTML'),
          'Finalize send',
        );
        this.messageId = result.message_id;
      } catch (err) {
        aiLogger.error({ err }, 'Finalize send failed');
      }
    }

    // Remaining chunks: send as new messages
    for (let i = 1; i < chunks.length; i++) {
      try {
        await withTelegramRateLimitRetry(
          () => this.sender.sendMessage(this.chatId, chunks[i]!, 'HTML'),
          'Finalize overflow send',
        );
      } catch (err) {
        aiLogger.warn({ err }, 'Failed to send overflow chunk with HTML, retrying plain text');
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
      const errStr = String(err);
      // "message is not modified" means the text is already displayed — no action needed
      if (errStr.includes('message is not modified')) return;
      aiLogger.error({ err }, 'Error fallback delivery also failed');
      // Last attempt: plain send (works whether messageId is set or not)
      await this.sender.sendMessage(this.chatId, errorText).catch(() => {});
    }
  }

  async discard(): Promise<void> {
    this.stopTypingLoop();
    this.discarded = true;
    // Wait for any pending placeholder creation so we can clean it up
    if (this.placeholderPromise) await this.placeholderPromise;
    if (this.messageId) {
      try {
        await this.sender.deleteMessage?.(this.chatId, this.messageId);
      } catch {
        /* ignore — message may already be gone */
      }
    }
  }

  /**
   * Drop the current in-flight draft (unflushed text, tool label, pending
   * indicators) without touching Telegram or the already-committed execution
   * log (`intermediateChunks`/`toolLines`). Used on its own for a provider
   * failover mid-stream — nothing has been distrusted yet, only the current
   * attempt is being redone. Committed *tool* lines are real work that
   * already happened and reach the "⚙️ Execution log" regardless of what
   * replaces the draft — showing them is never the model's call to make.
   * When the whole REQUEST turns out untrusted, use `resetForGuard()`
   * instead, which also strips committed reasoning prose.
   */
  resetDraft(): void {
    this.text = '';
    this.lastFlushedLength = 0;
    this.toolLabel = null;
    this.pendingIndicators = [];
    this.plainResponseText = '';
  }

  /**
   * Resets the draft AND strips already-committed reasoning-prose chunks
   * from the execution log, keeping every tool-result line. The pairing is
   * a single method, not caller discipline: use this — never `resetDraft()`
   * alone — whenever a request-wide guard fires (validator rejection, a
   * write-outcomes notice, a waiting/error termination). At that point NONE
   * of the model's own narration for this request is trustworthy, including
   * prose committed in an earlier round before the guard had a reason to
   * fire, while every tool call that actually ran stays real regardless.
   */
  resetForGuard(): void {
    this.resetDraft();
    this.intermediateChunks = this.intermediateChunks.filter((chunk) => chunk.kind !== 'reasoning');
  }

  getMessageId(): number | null {
    return this.messageId;
  }
}
