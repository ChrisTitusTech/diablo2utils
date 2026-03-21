import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('__electron_ipc__', {
  setClickthrough: (ignore) => ipcRenderer.send('set-clickthrough', ignore),
});
