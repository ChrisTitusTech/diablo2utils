import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('d2launcher', {
  // Get snapshot of all service statuses on init
  getStatuses: () => ipcRenderer.invoke('svc:statuses'),

  // Start / stop individual service by id ('map' | 'memory' | 'overlay')
  startService: (id) => ipcRenderer.invoke('svc:start', id),
  stopService: (id) => ipcRenderer.invoke('svc:stop', id),

  // Convenience: start / stop all
  startAll: () => ipcRenderer.invoke('svc:startAll'),
  stopAll: () => ipcRenderer.invoke('svc:stopAll'),

  // Subscribe to status changes: cb({ id, status })
  onStatus: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('svc:status', handler);
    return () => ipcRenderer.removeListener('svc:status', handler);
  },

  // Subscribe to log lines: cb({ id, line, stream })
  onLog: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('svc:log', handler);
    return () => ipcRenderer.removeListener('svc:log', handler);
  },

  // Config access
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
});
