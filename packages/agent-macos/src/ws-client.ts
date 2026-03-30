import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { AgentCommand, AgentOutbound } from './protocol';
import type { AgentResponse } from './protocol';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 90_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

function log(msg: string, data?: { [key: string]: unknown }): void {
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[WsClient ${ts}] ${msg}${extra}`);
}

type CommandHandler = (cmd: AgentCommand) => void;
type PairedHandler = (jwt: string) => void;
type PairErrorHandler = (reason: string) => void;

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private jwt: string | null;
  private serverUrl: string;
  private closed = false;
  private backoffMs = BACKOFF_INITIAL_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  onCommand: CommandHandler | null = null;
  onPaired: PairedHandler | null = null;
  onPairError: PairErrorHandler | null = null;

  constructor(serverUrl: string, jwt: string | null) {
    super();
    this.serverUrl = serverUrl;
    this.jwt = jwt;
  }

  connect(): void {
    if (this.closed) return;
    const headers: Record<string, string> = {};
    if (this.jwt) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }
    log('Connecting', { url: this.serverUrl, hasJwt: !!this.jwt, backoffMs: this.backoffMs });
    const ws = new WebSocket(this.serverUrl, { headers });
    this.ws = ws;

    ws.on('open', () => {
      log('WS open — connected to server');
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.emit('connected');
      this.startHeartbeat();
    });

    ws.on('message', (raw: Buffer | string) => {
      let msg: AgentOutbound;
      try {
        msg = JSON.parse(raw.toString()) as AgentOutbound;
      } catch {
        log('Message parse error', { raw: raw.toString().slice(0, 100) });
        return;
      }
      if (msg.type !== 'pong') {
        log('Message received', { type: msg.type });
      }
      this.handleMessage(msg);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      log('WS closed', { code, reason: reason.toString() });
      this.stopHeartbeat();
      this.emit('disconnected');
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      log('WS error', { message: err.message });
      // close event follows; errors are handled there
    });
  }

  private handleMessage(msg: AgentOutbound): void {
    if (msg.type === 'pong') {
      this.resetPongTimer();
      return;
    }

    if (msg.type === 'paired') {
      this.jwt = msg.jwt;
      this.onPaired?.(msg.jwt);
      this.emit('paired', msg.jwt);
      return;
    }

    if (msg.type === 'pair_error') {
      this.onPairError?.(msg.reason);
      this.emit('pair_error', msg.reason);
      return;
    }

    if (msg.type === 'token_refreshed') {
      this.jwt = msg.jwt;
      this.emit('token_refreshed', msg.jwt);
      return;
    }

    if (msg.type === 'cancel') {
      this.emit('cancel', msg.id);
      return;
    }

    if (
      msg.type === 'claude_chat' ||
      msg.type === 'claude_new_chat' ||
      msg.type === 'claude_list_chats' ||
      msg.type === 'claude_open_chat' ||
      msg.type === 'claude_list_projects' ||
      msg.type === 'claude_artifact' ||
      msg.type === 'bash_execute' ||
      msg.type === 'playwright_action' ||
      msg.type === 'applescript_run'
    ) {
      this.onCommand?.(msg);
      this.emit('command', msg);
    }
  }

  sendResponse(resp: AgentResponse): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(resp), (err) => {
        if (err) log('sendResponse error', { message: err.message });
      });
    }
  }

  pair(code: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'pair', code }), (err) => {
        if (err) log('pair send error', { message: err.message });
      });
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }), (err) => {
          if (err) log('ping send error', { message: err.message });
        });
        // Clear previous pong timer before setting a new one — otherwise
        // orphaned timers accumulate and close a healthy connection.
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = setTimeout(() => {
          log('Pong timeout — closing stale connection');
          this.ws?.close();
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private resetPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(): void {
    // Add ±20% jitter so a server restart doesn't get hammered by simultaneous reconnects.
    const jitter = this.backoffMs * 0.2 * (Math.random() * 2 - 1);
    const delay = Math.round(this.backoffMs + jitter);
    log('Scheduling reconnect', { backoffMs: delay });
    setTimeout(() => {
      this.connect();
    }, delay);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }
}
