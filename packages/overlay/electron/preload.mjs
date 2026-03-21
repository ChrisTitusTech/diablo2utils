import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__electron_ipc__', {
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  onToggleInteractive: (cb) => ipcRenderer.on('toggle-interactive', (_event, interactive) => cb(interactive)),
});
