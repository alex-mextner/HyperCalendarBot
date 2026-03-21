// src/agent/registry.ts
import type { ServerWebSocket } from 'bun';
import type { WsData } from './pairing.ts';

interface AgentConnection {
  ws: ServerWebSocket<WsData>;
  connectedAt: Date;
  lastPing: Date;
}

export class AgentRegistry {
  private connections = new Map<number, AgentConnection>();

  register(userId: number, ws: ServerWebSocket<WsData>): void {
    this.connections.set(userId, { ws, connectedAt: new Date(), lastPing: new Date() });
  }

  unregister(userId: number): void {
    this.connections.delete(userId);
  }

  isConnected(userId: number): boolean {
    return this.connections.has(userId);
  }

  get(userId: number): AgentConnection | undefined {
    return this.connections.get(userId);
  }

  updatePing(userId: number): void {
    const conn = this.connections.get(userId);
    if (conn) conn.lastPing = new Date();
  }
}

export const agentRegistry = new AgentRegistry();
