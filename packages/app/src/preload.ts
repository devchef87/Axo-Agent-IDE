import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('axo', {
  platform: process.platform,
  getNodes: () => ipcRenderer.invoke('axo:get-nodes'),
  pickFolder: () => ipcRenderer.invoke('axo:pick-folder'),
  restartLocalNode: () => ipcRenderer.invoke('axo:restart-local-node'),
  setTheme: (pref: string, background: string) => ipcRenderer.send('axo:set-theme', { pref, background }),
  servers: {
    snapshot: () => ipcRenderer.invoke('axo:servers:snapshot'),
    sshHosts: () => ipcRenderer.invoke('axo:servers:ssh-hosts'),
    add: (input: unknown) => ipcRenderer.invoke('axo:servers:add', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('axo:servers:update', id, patch),
    remove: (id: string, opts?: { stopNode?: boolean }) => ipcRenderer.invoke('axo:servers:remove', id, opts),
    preflight: (id: string) => ipcRenderer.invoke('axo:servers:preflight', id),
    deploy: (id: string) => ipcRenderer.invoke('axo:servers:deploy', id),
    cancelUpdate: (id: string) => ipcRenderer.invoke('axo:servers:cancel-update', id),
    connect: (id: string) => ipcRenderer.invoke('axo:servers:connect', id),
    disconnect: (id: string) => ipcRenderer.invoke('axo:servers:disconnect', id),
    updateLocal: () => ipcRenderer.invoke('axo:local:update'),
    cancelLocalUpdate: () => ipcRenderer.invoke('axo:local:cancel-update'),
    onChanged: (cb: (snap: unknown) => void) => {
      const h = (_: unknown, snap: unknown) => cb(snap);
      ipcRenderer.on('axo:servers-changed', h);
      return () => ipcRenderer.removeListener('axo:servers-changed', h);
    },
  },
  onNodesChanged: (cb: (nodes: unknown) => void) => {
    const h = (_: unknown, nodes: unknown) => cb(nodes);
    ipcRenderer.on('axo:nodes-changed', h);
    return () => ipcRenderer.removeListener('axo:nodes-changed', h);
  },
});
