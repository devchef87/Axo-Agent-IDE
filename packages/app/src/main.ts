import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerMonitor, shell } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ServerInput } from '@axo/protocol';
import { ensureLocalNode, stopLocalNode, type LocalNode } from './local-node.ts';
import { NodeManager, isStale, type NodeConn } from './node-manager.ts';
import { InnerChatRelay } from './relay.ts';

const DEV_UI = process.env.AXO_UI_URL;
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '..');
const NODE_BUNDLE = app.isPackaged ? join(resources, 'axo-node.mjs') : join(resources, 'core', 'dist', 'axo-node.mjs');
const UI_INDEX = app.isPackaged ? join(resources, 'ui', 'index.html') : join(resources, 'ui', 'dist', 'index.html');

let win: BrowserWindow | null = null;
let local: LocalNode | null = null;

function bundleInfo(): { version: string; build: string } {
  try { return JSON.parse(readFileSync(join(dirname(NODE_BUNDLE), 'axo-node.json'), 'utf8')); } catch { return { version: '?', build: 'dev' }; }
}

const manager = new NodeManager({
  dataDir: app.getPath('userData'),
  // ControlMaster sockets: short path, macOS caps unix socket paths at 104 bytes.
  sshEnv: { sshBin: 'ssh', controlDir: join(process.env.AXO_HOME || join(homedir(), '.axo'), 'ssh') },
  readBundle: () => readFileSync(NODE_BUNDLE),
  bundleInfo: bundleInfo(),
  restartLocal: async () => {
    await stopLocalNode();
    local = await ensureLocalNode(NODE_BUNDLE);
    return local;
  },
});
manager.on('nodes', (conns: NodeConn[]) => win?.webContents.send('axo:nodes-changed', conns));
manager.on('snapshot', (snap) => win?.webContents.send('axo:servers-changed', snap));

// name@server InnerChat: the app carries messages between nodes (they never talk directly).
// Runs in main, so it works with no window open; kicks immediately when a node (re)connects.
const relay = new InnerChatRelay(() => manager.relayEndpoints(), (m) => console.warn('[axo] innerchat', m));
relay.start();
manager.on('nodes', () => void relay.runOnce());

// ── Notifications ───────────────────────────────────────────
// The renderer decides which agent events notify (it holds the node connections);
// main shows them and routes clicks back. Keep references: a GC'd Notification loses its click handler.
type NotifyTarget = { kind: 'agent'; nodeKey: string; agentId: string } | { kind: 'servers' };
const shown = new Set<Notification>();
function notify(title: string, body: string, target: NotifyTarget): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  shown.add(n);
  const done = () => shown.delete(n);
  n.on('click', () => {
    done();
    if (!win) void createWindow().then(() => win?.webContents.send('axo:notification-click', target)); // resolves after the page loaded
    else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('axo:notification-click', target);
    }
  });
  n.on('close', done);
  n.on('failed', done);
  n.show();
}
ipcMain.on('axo:notify', (_e, n: { title: string; body: string; target: NotifyTarget }) => {
  if (typeof n?.title === 'string' && typeof n.body === 'string') notify(n.title.slice(0, 200), n.body.slice(0, 500), n.target);
});
manager.on('server-lost', (cfg: { name: string }, message: string) => {
  const title = `${cfg.name} disconnected`;
  const body = `${message}. Agents on the server keep running; Axo keeps reconnecting.`;
  // With a window, the renderer applies the user's notification setting and focus rules.
  if (win) win.webContents.send('axo:server-lost', { title, body });
  else notify(title, body, { kind: 'servers' });
});

// Theme: the renderer owns the preference; we mirror it so the window opens in the
// right colours next launch and native chrome (traffic lights, dialogs) matches.
type ThemePref = 'system' | 'light' | 'dark';
interface WindowTheme { pref: ThemePref; background: string }
const THEME_FILE = join(app.getPath('userData'), 'window-theme.json');
const DEFAULT_BG = { dark: '#32424F', light: '#fafafa' };

function loadTheme(): WindowTheme {
  try {
    const t = JSON.parse(readFileSync(THEME_FILE, 'utf8'));
    if (['system', 'light', 'dark'].includes(t.pref) && /^#[0-9a-f]{6}$/i.test(t.background)) return t;
  } catch { /* first launch */ }
  return { pref: 'system', background: '' };
}
let windowTheme = loadTheme();

function initialBackground(): string {
  // With "system", the OS may have flipped since last launch; trust it over the saved colour.
  if (windowTheme.pref === 'system' || !windowTheme.background) return nativeTheme.shouldUseDarkColors ? DEFAULT_BG.dark : DEFAULT_BG.light;
  return windowTheme.background;
}

function nodes(): NodeConn[] {
  return manager.conns();
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: initialBackground(),
    // 44px title bar in the renderer (px, not rem); 12px traffic lights centred in it: y = (44 - 12) / 2.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
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
ipcMain.on('axo:set-theme', (_e, t: Partial<WindowTheme>) => {
  if (!t || !['system', 'light', 'dark'].includes(t.pref as string) || !/^#[0-9a-f]{6}$/i.test(t.background ?? '')) return;
  const next = { pref: t.pref as ThemePref, background: t.background! };
  nativeTheme.themeSource = next.pref;
  win?.setBackgroundColor(next.background);
  if (next.pref === windowTheme.pref && next.background === windowTheme.background) return;
  windowTheme = next;
  try { writeFileSync(THEME_FILE, JSON.stringify(windowTheme)); } catch { /* non-fatal */ }
});
ipcMain.handle('axo:pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('axo:restart-local-node', async () => {
  await stopLocalNode();
  local = await ensureLocalNode(NODE_BUNDLE);
  await manager.setLocal(local);
  win?.webContents.send('axo:nodes-changed', nodes());
  win?.webContents.reload();
});

// Servers (Settings → Servers). Long operations resolve when done; progress arrives via 'axo:servers-changed'.
ipcMain.handle('axo:servers:snapshot', () => manager.snapshot());
ipcMain.handle('axo:servers:ssh-hosts', () => manager.sshHosts());
ipcMain.handle('axo:servers:add', (_e, input: ServerInput) => manager.add(input));
ipcMain.handle('axo:servers:update', (_e, id: string, patch: Partial<ServerInput>) => manager.update(id, patch));
ipcMain.handle('axo:servers:remove', (_e, id: string, opts?: { stopNode?: boolean }) => manager.remove(id, opts));
ipcMain.handle('axo:servers:preflight', (_e, id: string) => manager.preflight(id));
ipcMain.handle('axo:servers:deploy', (_e, id: string) => manager.deploy(id));
ipcMain.handle('axo:servers:cancel-update', (_e, id: string) => manager.cancelUpdate(id));
ipcMain.handle('axo:servers:connect', (_e, id: string) => manager.connect(id));
ipcMain.handle('axo:servers:disconnect', (_e, id: string) => manager.disconnect(id));
ipcMain.handle('axo:local:update', () => manager.updateLocal());
ipcMain.handle('axo:local:cancel-update', () => manager.cancelLocalUpdate());

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
            await manager.setLocal(local);
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
  nativeTheme.themeSource = windowTheme.pref;
  buildMenu();
  try {
    local = await ensureLocalNode(NODE_BUNDLE);
    await manager.setLocal(local);
    // A node left running from an older build (e.g. after a rebuild): swap it
    // for the bundled one as soon as no agent is mid-turn. Agents resume by session.
    if (isStale({ version: local.version, build: local.build, nodeId: '', hostname: '' }, bundleInfo().build)) void manager.updateLocal();
  } catch (e: any) {
    dialog.showErrorBox('Axo', e.message);
  }
  await createWindow();
  manager.connectAutos();
  powerMonitor.on('resume', () => manager.kickAll());
  app.on('activate', () => { if (!win) void createWindow(); });
});

// Tunnels are children of the app; remote nodes and their agents keep running.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  relay.stop();
  void manager.shutdown().finally(() => app.quit());
});

// Agents live in the detached node, so quitting the app leaves them running.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
