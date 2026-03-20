// src/services/group/group-session.ts
import type { GroupSessionRepository } from '../../database/repositories/group-session.repository.ts';

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
  constructor(private repo: GroupSessionRepository) {}

  activate(chatId: number, userId: number, botMessageId: number): void {
    this.repo.upsert({
      chatId,
      activatedBy: userId,
      remainingMessages: SESSION_WINDOW,
      lastBotMessageId: botMessageId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  hasActiveSession(chatId: number): boolean {
    const session = this.repo.get(chatId);
    if (!session) return false;
    if (session.expiresAt <= Date.now() || session.remainingMessages <= 0) {
      this.repo.delete(chatId);
      return false;
    }
    return true;
  }

  getSession(chatId: number): GroupSession | undefined {
    const session = this.repo.get(chatId);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now() || session.remainingMessages <= 0) {
      this.repo.delete(chatId);
      return undefined;
    }
    return session;
  }

  tick(chatId: number): void {
    const session = this.repo.get(chatId);
    if (!session) return;
    session.remainingMessages -= 1;
    if (session.remainingMessages <= 0) {
      this.repo.delete(chatId);
    } else {
      this.repo.upsert(session);
    }
  }

  refresh(chatId: number, botMessageId: number): void {
    const session = this.repo.get(chatId);
    if (!session) return;
    this.repo.upsert({
      ...session,
      remainingMessages: SESSION_WINDOW,
      lastBotMessageId: botMessageId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
  }

  close(chatId: number): void {
    this.repo.delete(chatId);
  }
}
