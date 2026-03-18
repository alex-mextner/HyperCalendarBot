const SESSION_WINDOW = 10;
const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000; // 5 days

export interface GroupSession {
  chatId: number;
  activatedBy: number;
  remainingMessages: number;
  lastBotMessageId: number;
  expiresAt: number;
}

export class GroupSessionManager {
  private sessions = new Map<number, GroupSession>();

  activate(chatId: number, userId: number, botMessageId: number): void {
    this.sessions.set(chatId, {
      chatId,
      activatedBy: userId,
      remainingMessages: SESSION_WINDOW,
      lastBotMessageId: botMessageId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  hasActiveSession(chatId: number): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;

    if (session.expiresAt <= Date.now() || session.remainingMessages <= 0) {
      this.sessions.delete(chatId);
      return false;
    }

    return true;
  }

  getSession(chatId: number): GroupSession | undefined {
    return this.sessions.get(chatId);
  }

  tick(chatId: number): void {
    const session = this.sessions.get(chatId);
    if (!session) return;

    session.remainingMessages -= 1;

    if (session.remainingMessages <= 0) {
      this.sessions.delete(chatId);
    }
  }

  refresh(chatId: number, botMessageId: number): void {
    const session = this.sessions.get(chatId);
    if (!session) return;

    session.remainingMessages = SESSION_WINDOW;
    session.lastBotMessageId = botMessageId;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  close(chatId: number): void {
    this.sessions.delete(chatId);
  }
}
