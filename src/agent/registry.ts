// src/agent/registry.ts
import type { ServerWebSocket } from 'bun';
import { logger } from '../utils/logger.ts';
import type { WsData } from './pairing.ts';

const registryLogger = logger.child({ module: 'agent-registry' });

interface AgentConnection {
  ws: ServerWebSocket<WsData>;
  connectedAt: Date;
  lastPing: Date;
}

export class AgentRegistry {
  private connections = new Map<number, AgentConnection>();

  register(userId: number, ws: ServerWebSocket<WsData>): void {
    const hadPrevious = this.connections.has(userId);
    this.connections.set(userId, { ws, connectedAt: new Date(), lastPing: new Date() });
    registryLogger.info({ userId, replaced: hadPrevious, total: this.connections.size }, 'Agent registered');
  }

  unregister(userId: number): void {
    const had = this.connections.delete(userId);
    registryLogger.info({ userId, wasPresent: had, total: this.connections.size }, 'Agent unregistered');
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
