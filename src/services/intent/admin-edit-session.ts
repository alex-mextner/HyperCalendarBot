// src/services/intent/admin-edit-session.ts

export interface AdminEditSession {
  intentId: number;
  state: 'awaiting_instructions';
  createdAt: number;
}

export const ADMIN_EDIT_SESSION_TTL_MS = 10 * 60 * 1000;

export function isSessionExpired(session: AdminEditSession): boolean {
  return Date.now() - session.createdAt > ADMIN_EDIT_SESSION_TTL_MS;
}
