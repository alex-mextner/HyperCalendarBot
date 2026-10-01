// src/services/voice/call-session-manager.ts
import { type CallLanguage, voiceLogger } from './types.ts';

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
    language: CallLanguage,
    ws: { send: (data: string | Buffer) => void; close: () => void },
    openerText: string,
  ) => ManagedSession;
  timeoutMs?: number;
}

export class CallSessionManager {
  private sessions = new Map<string, { session: ManagedSession; timer: ReturnType<typeof setTimeout> }>();
  private pendingSessions = new Map<string, { userId: number; language: CallLanguage; openerText: string }>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: CallSessionManagerDeps) {
    this.timeoutMs = deps.timeoutMs ?? SESSION_TIMEOUT_MS;
  }

  /** Prepares the session the bridge will connect to; `openerText` is spoken first once the call connects. */
  registerSession(sessionId: string, userId: number, language: CallLanguage, openerText: string): void {
    this.pendingSessions.set(sessionId, { userId, language, openerText });
  }

  /** Forgets a registered session whose bridge never connected; a session that already opened is left alone. */
  unregisterSession(sessionId: string): void {
    this.pendingSessions.delete(sessionId);
  }

  onWebSocketOpen(sessionId: string, ws: { send: (data: string | Buffer) => void; close: () => void }): void {
    const ctx = this.pendingSessions.get(sessionId);
    if (!ctx) {
      voiceLogger.error({ sessionId }, 'No pending session for WebSocket connection — closing');
      ws.close();
      return;
    }
    this.pendingSessions.delete(sessionId);
    const session = this.deps.createSession(sessionId, ctx.userId, ctx.language, ws, ctx.openerText);
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
      entry.session.handleBinaryMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
    } else if (typeof data === 'string') {
      await entry.session.handleMessage(data);
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
    Bun.serve<{ sessionId: string }>({
      port: 3001,
      hostname: '127.0.0.1',
      fetch(req, server): Response | undefined {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/call\/([^/]+)$/);
        if (!match) return new Response('Not found', { status: 404 });
        const sessionId = match[1]!;
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) return new Response('Upgrade failed', { status: 426 });
        return undefined;
      },
      websocket: {
        idleTimeout: 960,
        open: (ws) => {
          const { sessionId } = ws.data;
          this.onWebSocketOpen(sessionId, {
            send: (data) => ws.send(data),
            close: () => ws.close(),
          });
        },
        message: (ws, message) => {
          const { sessionId } = ws.data;
          const isBinary = typeof message !== 'string';
          this.onWebSocketMessage(sessionId, message, isBinary).catch((err) => {
            voiceLogger.error({ err, sessionId }, 'WebSocket message handler error');
          });
        },
        close: (ws) => {
          const { sessionId } = ws.data;
          this.onWebSocketClose(sessionId);
        },
      },
    });
    voiceLogger.info({ port: 3001 }, 'Call WebSocket server started');
  }
}
