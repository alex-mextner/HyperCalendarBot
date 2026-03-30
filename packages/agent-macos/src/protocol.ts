// Re-export shared WebSocket types from the bot server.
// These are duplicated here (not imported directly) to keep Electron
// dependencies isolated from the bot's Bun runtime.

export interface AgentPairRequest {
  type: 'pair';
  code: string;
}
export interface AgentPairResponse {
  type: 'paired';
  jwt: string;
}
export interface AgentPairError {
  type: 'pair_error';
  reason: 'expired' | 'invalid';
}

export type AgentCommand =
  | { id: string; type: 'bash_execute'; payload: { command: string; timeout_ms?: number } }
  | { id: string; type: 'applescript_run'; payload: { script: string; timeout_ms?: number } }
  | { id: string; type: 'claude_chat'; payload: { message: string; chat_id?: string; timeout_ms?: number } }
  | { id: string; type: 'claude_new_chat'; payload: { message: string } }
  | { id: string; type: 'claude_list_chats'; payload?: { [key: string]: unknown } }
  | { id: string; type: 'claude_open_chat'; payload: { chat_id: string } }
  | { id: string; type: 'claude_list_projects'; payload?: { [key: string]: unknown } }
  | { id: string; type: 'claude_artifact'; payload: { artifact_id: string } }
  | {
      id: string;
      type: 'playwright_action';
      payload: {
        action: string;
        url?: string;
        selector?: string;
        value?: string;
        timeout_ms?: number;
      };
    };

export interface AgentResponse {
  id: string;
  type: 'chunk' | 'done' | 'error';
  text?: string;
  data?: unknown;
  exitCode?: number;
  error?: string;
}

export interface AgentPing {
  type: 'ping';
}
export interface AgentPong {
  type: 'pong';
}
export interface AgentCancel {
  type: 'cancel';
  id: string;
}
export interface AgentTokenRefreshed {
  type: 'token_refreshed';
  jwt: string;
}

export type AgentInbound = AgentPairRequest | AgentResponse | AgentPing;
export type AgentOutbound =
  | AgentPairResponse
  | AgentPairError
  | AgentCommand
  | AgentPong
  | AgentCancel
  | AgentTokenRefreshed;
