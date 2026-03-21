import { contextBridge, ipcRenderer } from 'electron';

const savedZoom = ipcRenderer.sendSync('get-saved-zoom');
const savedCenter = ipcRenderer.sendSync('get-saved-center');

contextBridge.exposeInMainWorld('__electron_ipc__', {
  saveZoom: (zoom) => ipcRenderer.send('save-zoom', zoom),
  getSavedZoom: () => savedZoom,
  saveCenter: (center) => ipcRenderer.send('save-center', center),
  getSavedCenter: () => savedCenter,
});
