import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import type { WsClient } from './ws-client';

const ICON_CONNECTED = join(__dirname, '../assets/tray-connected.png');
const ICON_DISCONNECTED = join(__dirname, '../assets/tray-disconnected.png');

export type ClaudeStatus = 'unknown' | 'ok' | 'error';

function loadIcon(path: string) {
  const img = nativeImage.createFromPath(path);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

export function createTray(wsClient: WsClient): { tray: Tray; setClaudeStatus: (s: ClaudeStatus) => void } {
  const tray = new Tray(loadIcon(wsClient.isConnected() ? ICON_CONNECTED : ICON_DISCONNECTED));
  tray.setToolTip('HyperBot Agent');

  let claudeStatus: ClaudeStatus = 'unknown';

  const claudeLabel = () => {
    if (claudeStatus === 'ok') return '● Claude: OK';
    if (claudeStatus === 'error') return '○ Claude: error (check login at claude.ai)';
    return '○ Claude: checking...';
  };

  const updateMenu = (connected: boolean) => {
    const status = connected ? '● Server: connected' : '○ Server: disconnected';
    const loginItem = app.getLoginItemSettings();

    const menu = Menu.buildFromTemplate([
      { label: status, enabled: false },
      { label: claudeLabel(), enabled: false },
      { type: 'separator' },
      {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: loginItem.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
        },
      },
      { type: 'separator' },
      {
        label: 'Disconnect',
        click: () => {
          wsClient.close();
        },
      },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(menu);
    tray.setImage(loadIcon(connected ? ICON_CONNECTED : ICON_DISCONNECTED));
  };

  updateMenu(wsClient.isConnected());

  wsClient.on('connected', () => updateMenu(true));
  wsClient.on('disconnected', () => updateMenu(false));

  const setClaudeStatus = (s: ClaudeStatus) => {
    claudeStatus = s;
    updateMenu(wsClient.isConnected());
  };

  return { tray, setClaudeStatus };
}
