import { app, clipboard, dialog, Notification, type Tray } from 'electron';
import { dispatch } from './dispatcher';
import { claudeChat, initClaudeCookies } from './actions/claude-bridge';
import { initOAuth } from './oauth-manager';
import { loadJwt, saveJwt } from './keychain';
import { generatePairingCode } from './pairing';
import { createTray } from './tray';
import { WsClient } from './ws-client';

// Keep Tray reference at module scope — Electron destroys it if GC'd
let tray: Tray | undefined;

const WS_URL = process.env.HYPERBOT_WS_URL ?? 'wss://hypercal.invntrm.ru/ws/agent';

function log(msg: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[Agent ${ts}] ${msg}${extra}`);
}

async function main(): Promise<void> {
  await app.whenReady();

  // Tray-only app — must hide dock after app is ready
  app.dock?.hide();

  const jwt = await loadJwt();
  log('JWT loaded', { hasJwt: !!jwt });
  const wsClient = new WsClient(WS_URL, jwt);

  // Persist refreshed tokens
  wsClient.on('token_refreshed', (newJwt: string) => {
    saveJwt(newJwt).catch((err: unknown) => console.error('Failed to save refreshed JWT:', err));
  });

  // Pairing flow
  wsClient.on('connected', () => log('Agent connected to server'));
  wsClient.on('disconnected', () => log('Agent disconnected from server'));

  wsClient.on('paired', (newJwt: string) => {
    log('Paired — saving JWT');
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
    const isClaudeCmd = cmd.type.startsWith('claude_');
    dispatch(cmd, (resp) => {
      if (isClaudeCmd) {
        if (resp.type === 'done') setClaudeStatus('ok');
        else if (resp.type === 'error') setClaudeStatus('error');
      }
      wsClient.sendResponse(resp);
    }).catch((err: unknown) => {
      if (isClaudeCmd) setClaudeStatus('error');
      wsClient.sendResponse({
        id: cmd.id,
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  const { tray: trayInst, setClaudeStatus } = createTray(wsClient);
  tray = trayInst;

  // Load Claude Desktop cookies into the Electron session before any API calls
  await initClaudeCookies();

  // Acquire OAuth tokens (uses sessionKey cookie loaded above)
  try {
    await initOAuth();
    log('OAuth init OK');
  } catch (err: unknown) {
    log('OAuth init failed', { err: err instanceof Error ? err.message : String(err) });
  }

  // Probe Claude connectivity: POST a real chat round-trip via official API
  async function probeClaudeStatus(): Promise<void> {
    try {
      const { response } = await claudeChat('Say "ok" and nothing else.', undefined, undefined);
      log('Claude API chat OK', { responseLen: response.length });
      setClaudeStatus('ok');
    } catch (err: unknown) {
      log('Claude API error', { err: err instanceof Error ? err.message : String(err) });
      setClaudeStatus('error');
    }
  }

  probeClaudeStatus().catch(() => {/* logged inside */});

  // Re-probe every 5 minutes so tray status stays current
  setInterval(() => {
    probeClaudeStatus().catch(() => {/* logged inside */});
  }, 5 * 60_000);

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
