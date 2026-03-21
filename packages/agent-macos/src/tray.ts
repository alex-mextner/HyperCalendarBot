import { app, Menu, Tray } from 'electron';
import type { WsClient } from './ws-client.ts';

const ICON_CONNECTED = `${__dirname}/../assets/tray-connected.png`;
const ICON_DISCONNECTED = `${__dirname}/../assets/tray-disconnected.png`;

export function createTray(wsClient: WsClient): Tray {
  const iconPath = wsClient.isConnected() ? ICON_CONNECTED : ICON_DISCONNECTED;
  const tray = new Tray(iconPath);
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
    tray.setImage(connected ? ICON_CONNECTED : ICON_DISCONNECTED);
  };

  updateMenu(wsClient.isConnected());

  wsClient.on('connected', () => updateMenu(true));
  wsClient.on('disconnected', () => updateMenu(false));

  return tray;
}
