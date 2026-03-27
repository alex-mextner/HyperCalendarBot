import { app, clipboard, dialog, Notification, type Tray } from 'electron';
import { dispatch } from './dispatcher';
import { loadJwt, saveJwt } from './keychain';
import { generatePairingCode } from './pairing';
import { createTray } from './tray';
import { WsClient } from './ws-client';

// Keep Tray reference at module scope — Electron destroys it if GC'd
let tray: Tray | undefined;

const WS_URL = process.env.HYPERBOT_WS_URL ?? 'wss://hypercal.invntrm.ru/ws/agent';

async function main(): Promise<void> {
  await app.whenReady();

  // Tray-only app — must hide dock after app is ready
  app.dock?.hide();

  const jwt = await loadJwt();
  const wsClient = new WsClient(WS_URL, jwt);

  // Persist refreshed tokens
  wsClient.on('token_refreshed', (newJwt: string) => {
    saveJwt(newJwt).catch((err: unknown) => console.error('Failed to save refreshed JWT:', err));
  });

  // Pairing flow
  wsClient.on('paired', (newJwt: string) => {
    saveJwt(newJwt).catch((err: unknown) => console.error('Failed to save JWT:', err));
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

  tray = createTray(wsClient);

  if (!jwt) {
    // First launch — generate pairing code and initiate pairing
    const code = generatePairingCode();
    wsClient.connect();

    // Wait for the socket to open before sending the pair message
    wsClient.once('connected', () => {
      wsClient.pair(code);
      dialog.showMessageBox({
        type: 'info',
        title: 'HyperBot Agent — Setup',
        message: 'Send this command to your bot in Telegram:',
        detail: `/activate ${code}`,
        buttons: ['Copy & Close'],
      }).then(() => {
        clipboard.writeText(`/activate ${code}`);
      });
    });
  } else {
    wsClient.connect();
  }

  // Prevent the app from quitting when all windows are closed (tray-only)
  app.on('window-all-closed', () => {
    // tray-only app — stay alive when all windows are closed
  });
}

main().catch((err: unknown) => {
  console.error('Fatal error in main:', err);
  process.exit(1);
});
