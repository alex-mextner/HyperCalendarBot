// src/bot/commands/connect.command.ts
import { completePairing } from '../../agent/pairing.ts';
import type { AgentRegistry } from '../../agent/registry.ts';
import { t } from '../../config/constants.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';

export interface ConnectCtx {
  user?: { telegram_id?: number; language?: string };
  args?: string | null;
  send: (text: string) => Promise<unknown>;
}

export function createConnectCommand(downloadUrl: string) {
  return async function connectCommand(ctx: ConnectCtx): Promise<void> {
    const lang = ctx.user?.language === 'ru' ? 'ru' : 'en';
    await ctx.send(t(lang).aiTools.agent.connectMessage(downloadUrl));
  };
}

export function createActivateCommand(registry: AgentRegistry) {
  return async function activateCommand(ctx: ConnectCtx): Promise<void> {
    const code = ctx.args?.trim();
    const userId = ctx.user?.telegram_id ?? 0;
    const lang = ctx.user?.language === 'ru' ? 'ru' : 'en';

    if (!code) {
      await ctx.send(t(lang).aiTools.agent.activatePrompt);
      return;
    }

    const ok = await completePairing(code, userId, registry);
    await ctx.send(ok ? t(lang).aiTools.agent.activated : t(lang).aiTools.agent.activationFailed);
  };
}

export function createDisconnectCommand(registry: AgentRegistry, userRepo: UserRepository) {
  return async function disconnectCommand(ctx: ConnectCtx): Promise<void> {
    const userId = ctx.user?.telegram_id ?? 0;
    const lang = ctx.user?.language === 'ru' ? 'ru' : 'en';

    const conn = registry.get(userId);
    if (conn) {
      conn.ws.close(4003, 'Disconnected by user');
    }
    userRepo.updateAssistantEnabled(userId, false);
    await ctx.send(conn ? t(lang).aiTools.agent.disconnected : t(lang).aiTools.agent.notConnected);
  };
}
