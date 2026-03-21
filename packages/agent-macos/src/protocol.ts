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

export interface AgentCommand {
  id: string;
  type:
    | 'claude_chat'
    | 'claude_new_chat'
    | 'claude_list_chats'
    | 'claude_open_chat'
    | 'claude_list_projects'
    | 'claude_artifact'
    | 'bash_execute'
    | 'playwright_action'
    | 'applescript_run';
  payload: Record<string, unknown>;
}

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
