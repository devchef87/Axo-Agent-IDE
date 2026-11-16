import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { join } from 'node:path';
import { ensureLocalNode, stopLocalNode, type LocalNode } from './local-node.ts';

const DEV_UI = process.env.AXO_UI_URL;
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..');
const NODE_BUNDLE = app.isPackaged ? join(resources, 'axo-node.mjs') : join(resources, 'core', 'dist', 'axo-node.mjs');
const UI_INDEX = app.isPackaged ? join(resources, 'ui', 'index.html') : join(resources, 'ui', 'dist', 'index.html');

let win: BrowserWindow | null = null;
let local: LocalNode | null = null;

interface NodeConn { key: string; name: string; baseUrl: string; token: string }

function nodes(): NodeConn[] {
  return local ? [{ key: 'local', name: 'Local', baseUrl: local.baseUrl, token: local.token }] : [];
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#24282f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 9 },
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });
  // External links open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !(DEV_UI && url.startsWith(DEV_UI))) { e.preventDefault(); void shell.openExternal(url); }
  });

  if (DEV_UI) await win.loadURL(DEV_UI);
  else await win.loadFile(UI_INDEX);
}

ipcMain.handle('axo:get-nodes', () => nodes());
ipcMain.handle('axo:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('axo:restart-local-node', async () => {
  await stopLocalNode();
  local = await ensureLocalNode(NODE_BUNDLE);
  win?.webContents.send('axo:nodes-changed', nodes());
  win?.webContents.reload();
});

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Node',
      submenu: [
        {
          label: 'Restart Local Node',
          click: async () => {
            const ok = await dialog.showMessageBox(win!, {
              type: 'question', buttons: ['Restart', 'Cancel'], defaultId: 0, cancelId: 1,
              message: 'Restart the local Axo node?',
              detail: 'Running turns are cut short; every agent keeps its session and resumes on the next message.',
            });
            if (ok.response !== 0) return;
            await stopLocalNode();
            local = await ensureLocalNode(NODE_BUNDLE);
            win?.webContents.reload();
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    local = await ensureLocalNode(NODE_BUNDLE);
  } catch (e: any) {
    dialog.showErrorBox('Axo', e.message);
  }
  await createWindow();
  app.on('activate', () => { if (!win) void createWindow(); });
});

// Agents live in the detached node, so quitting the app leaves them running.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
