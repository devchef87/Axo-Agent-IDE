import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('axo', {
  platform: process.platform,
  getNodes: () => ipcRenderer.invoke('axo:get-nodes'),
  pickFolder: () => ipcRenderer.invoke('axo:pick-folder'),
  restartLocalNode: () => ipcRenderer.invoke('axo:restart-local-node'),
  setTheme: (pref: string, background: string) => ipcRenderer.send('axo:set-theme', { pref, background }),
  onNodesChanged: (cb: (nodes: unknown) => void) => {
    const h = (_: unknown, nodes: unknown) => cb(nodes);
    ipcRenderer.on('axo:nodes-changed', h);
    return () => ipcRenderer.removeListener('axo:nodes-changed', h);
  },
});
