import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import type { WsClient } from './ws-client.ts';

const ICON_CONNECTED = join(__dirname, '../assets/tray-connected.png');
const ICON_DISCONNECTED = join(__dirname, '../assets/tray-disconnected.png');

function loadIcon(path: string) {
  const img = nativeImage.createFromPath(path);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

export function createTray(wsClient: WsClient): Tray {
  const tray = new Tray(loadIcon(wsClient.isConnected() ? ICON_CONNECTED : ICON_DISCONNECTED));
  tray.setToolTip('HyperBot Agent');

  const updateMenu = (connected: boolean) => {
    const status = connected ? '● Connected' : '○ Not connected';
    const loginItem = app.getLoginItemSettings();

    const menu = Menu.buildFromTemplate([
      { label: status, enabled: false },
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

  return tray;
}
