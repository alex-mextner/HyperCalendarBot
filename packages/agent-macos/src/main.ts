import { app, Notification } from 'electron';
import { dispatch } from './dispatcher.ts';
import { loadJwt, saveJwt } from './keychain.ts';
import { generatePairingCode } from './pairing.ts';
import { createTray } from './tray.ts';
import { WsClient } from './ws-client.ts';

const WS_URL = process.env.HYPERBOT_WS_URL ?? 'wss://hypercal.invntrm.ru/ws/agent';

async function main(): Promise<void> {
  // Tray-only app — no dock icon
  app.dock?.hide();

  await app.whenReady();

  const jwt = await loadJwt();
  const wsClient = new WsClient(WS_URL, jwt);

  // Persist refreshed tokens
  wsClient.on('token_refreshed', (newJwt: string) => {
    saveJwt(newJwt).catch(() => {});
  });

  // Pairing flow
  wsClient.on('paired', (newJwt: string) => {
    saveJwt(newJwt).catch(() => {});
    new Notification({
      title: 'HyperBot Agent',
      body: 'Connected to HyperBot! AI Assistant is ready.',
    }).show();
  });

  wsClient.on('pair_error', (reason: string) => {
    new Notification({
      title: 'HyperBot Agent',
      body: `Pairing failed: ${reason}. Open the bot and try /activate again.`,
    }).show();
  });

  // Incoming command dispatch
  wsClient.on('command', (cmd) => {
    dispatch(cmd, (resp) => wsClient.sendResponse(resp)).catch((err: unknown) => {
      wsClient.sendResponse({
        id: cmd.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  createTray(wsClient);

  if (!jwt) {
    // First launch — generate pairing code and initiate pairing
    const code = generatePairingCode();
    wsClient.connect();

    // Wait for the socket to open before sending the pair message
    wsClient.once('connected', () => {
      wsClient.pair(code);
      new Notification({
        title: 'HyperBot Agent — Setup',
        body: `Send to your bot in Telegram: /activate ${code}`,
      }).show();
    });
  } else {
    wsClient.connect();
  }

  // Prevent the app from quitting when all windows are closed (tray-only)
  app.on('window-all-closed', (e: Event) => {
    e.preventDefault();
  });
}

main().catch((err: unknown) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
