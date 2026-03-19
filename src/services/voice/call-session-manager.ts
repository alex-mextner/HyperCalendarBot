// src/services/voice/call-session-manager.ts
import { voiceLogger } from './types.ts';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ManagedSession {
  handleMessage: (data: string) => Promise<void>;
  handleBinaryMessage: (data: Buffer) => void;
  isEnded: () => boolean;
  forceEnd?: () => void;
}

export interface CallSessionManagerDeps {
  createSession: (
    sessionId: string,
    userId: number,
    language: 'ru' | 'en',
    ws: { send: (data: string) => void; close: () => void },
  ) => ManagedSession;
  timeoutMs?: number;
}

export class CallSessionManager {
  private sessions = new Map<string, { session: ManagedSession; timer: ReturnType<typeof setTimeout> }>();
  private pendingSessions = new Map<string, { userId: number; language: 'ru' | 'en' }>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: CallSessionManagerDeps) {
    this.timeoutMs = deps.timeoutMs ?? SESSION_TIMEOUT_MS;
  }

  registerSession(sessionId: string, userId: number, language: string): void {
    const lang: 'ru' | 'en' = language === 'en' ? 'en' : language === 'ru' ? 'ru' : 'ru';
    if (language !== 'ru' && language !== 'en') {
      voiceLogger.warn({ sessionId, language }, 'Unexpected language in registerSession, defaulting to ru');
    }
    this.pendingSessions.set(sessionId, { userId, language: lang });
  }

  onWebSocketOpen(sessionId: string, ws: { send: (data: string) => void; close: () => void }): void {
    const ctx = this.pendingSessions.get(sessionId) ?? { userId: 0, language: 'ru' as const };
    this.pendingSessions.delete(sessionId);
    const session = this.deps.createSession(sessionId, ctx.userId, ctx.language, ws);
    const timer = setTimeout(() => {
      voiceLogger.warn({ sessionId }, 'Session timeout — forcing end');
      session.forceEnd?.();
      ws.close();
      this.sessions.delete(sessionId);
    }, this.timeoutMs);

    this.sessions.set(sessionId, { session, timer });
    voiceLogger.info({ sessionId }, 'Call session opened');
  }

  async onWebSocketMessage(sessionId: string, data: string | Buffer, isBinary: boolean): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (isBinary) {
      entry.session.handleBinaryMessage(Buffer.isBuffer(data) ? data : Buffer.from(data as string));
    } else {
      await entry.session.handleMessage(data as string);
    }
  }

  onWebSocketClose(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    voiceLogger.info({ sessionId }, 'Call session closed');
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /** Start the WebSocket server on :3001 */
  startServer(): void {
    Bun.serve({
      port: 3001,
      hostname: '127.0.0.1',
      fetch(req, server): Response | undefined {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/call\/([^/]+)$/);
        if (!match) return new Response('Not found', { status: 404 });
        const sessionId = match[1];
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) return new Response('Upgrade failed', { status: 426 });
        return undefined;
      },
      websocket: {
        open: (ws) => {
          const { sessionId } = ws.data as { sessionId: string };
          this.onWebSocketOpen(sessionId, {
            send: (data) => ws.send(data),
            close: () => ws.close(),
          });
        },
        message: (ws, message) => {
          const { sessionId } = ws.data as { sessionId: string };
          const isBinary = typeof message !== 'string';
          this.onWebSocketMessage(sessionId, message as string | Buffer, isBinary).catch((err) => {
            voiceLogger.error({ err, sessionId }, 'WebSocket message handler error');
          });
        },
        close: (ws) => {
          const { sessionId } = ws.data as { sessionId: string };
          this.onWebSocketClose(sessionId);
        },
      },
    });
    voiceLogger.info({ port: 3001 }, 'Call WebSocket server started');
  }
}
