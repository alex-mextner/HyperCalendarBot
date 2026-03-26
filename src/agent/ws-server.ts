// src/agent/ws-server.ts
import type { ServerWebSocket } from 'bun';
import { jsonCodec } from '../utils/json-codec.ts';
import type { AgentDispatcher } from './dispatcher.ts';
import { issueAgentJwt, registerPendingConnection, verifyAgentJwtFull, type WsData } from './pairing.ts';
import { AgentInboundSchema, type AgentTokenRefreshed } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

const AgentInboundCodec = jsonCodec(AgentInboundSchema);

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

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
        const result = await verifyAgentJwtFull(ws.data._token);
        if (!result) {
          ws.close(4001, 'JWT invalid');
          return;
        }
        ws.data.userId = result.userId;
        registry.register(result.userId, ws);

        // Proactively refresh JWT if it expires within 7 days
        if (result.exp * 1000 - Date.now() < REFRESH_THRESHOLD_MS) {
          const newJwt = await issueAgentJwt(result.userId);
          const msg: AgentTokenRefreshed = { type: 'token_refreshed', jwt: newJwt };
          ws.send(JSON.stringify(msg));
        }
      } else {
        // No JWT — allow pairing window, then close if still unauthenticated
        setTimeout(() => {
          if (ws.data.userId === null && typeof ws.close === 'function') {
            ws.close(4002, 'Authentication timeout');
          }
        }, 30_000);
      }
    },

    message(ws: ServerWebSocket<WsData>, raw: string) {
      const result = AgentInboundCodec.safeParse(raw);
      if (!result.success) return;
      const msg = result.data;

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
