// src/bot/commands/connect.command.ts
import { completePairing } from '../../agent/pairing.ts';
import type { AgentRegistry } from '../../agent/registry.ts';

export interface ConnectCtx {
  user?: { telegram_id?: number; language?: string };
  args?: string | null;
  send: (text: string) => Promise<void>;
}

export async function connectCommand(ctx: ConnectCtx): Promise<void> {
  const url = process.env.AGENT_DOWNLOAD_URL ?? '';
  const ru = ctx.user?.language === 'ru';
  await ctx.send(
    ru
      ? `🔗 *Подключить AI Ассистент*\n\nСкачай агент для macOS:\n${url}\n\nПосле установки приложение само покажет команду активации.`
      : `🔗 *Connect AI Assistant*\n\nDownload the macOS agent:\n${url}\n\nAfter installing, the app will show an activation command.`,
  );
}

export function createActivateCommand(registry: AgentRegistry) {
  return async function activateCommand(ctx: ConnectCtx): Promise<void> {
    const code = ctx.args?.trim();
    const userId = ctx.user?.telegram_id ?? 0;
    const ru = ctx.user?.language === 'ru';

    if (!code) {
      await ctx.send(
        ru ? 'Укажи код из приложения: /activate <код>' : 'Provide the code from the app: /activate <code>',
      );
      return;
    }

    const ok = await completePairing(code, userId, registry);
    await ctx.send(
      ok
        ? ru
          ? '✅ Агент подключён!'
          : '✅ Agent connected!'
        : ru
          ? '❌ Код не найден или истёк. Открой приложение и скопируй команду заново.'
          : '❌ Code not found or expired. Open the app and copy the command again.',
    );
  };
}
