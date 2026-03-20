// src/agent/ws-server.ts
import type { ServerWebSocket } from 'bun';
import type { AgentDispatcher } from './dispatcher.ts';
import { registerPendingConnection, verifyAgentJwt, type WsData } from './pairing.ts';
import type { AgentInbound } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

export function upgradeAgentWs(
  req: Request,
  server: { upgrade(req: Request, opts: { data: WsData }): boolean },
): boolean {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? null;
  return server.upgrade(req, { data: { userId: null, _token: token } });
}

export function createAgentWsHandler(registry: AgentRegistry, dispatcher: AgentDispatcher) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      if (ws.data._token) {
        const userId = await verifyAgentJwt(ws.data._token);
        if (!userId) {
          ws.close(4001, 'JWT invalid');
          return;
        }
        ws.data.userId = userId;
        registry.register(userId, ws);
      }
    },

    message(ws: ServerWebSocket<WsData>, raw: string) {
      let msg: AgentInbound;
      try {
        msg = JSON.parse(raw) as AgentInbound;
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        if (ws.data.userId) registry.updatePing(ws.data.userId);
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'pair') {
        registerPendingConnection(msg.code, ws);
        return;
      }

      if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'error') {
        dispatcher.handleResponse(msg);
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.userId) {
        dispatcher.rejectPendingForUser(ws.data.userId, new Error('Agent disconnected'));
        registry.unregister(ws.data.userId);
      }
    },
  };
}
