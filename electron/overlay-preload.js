'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onStateUpdate: (callback) => {
    ipcRenderer.on('overlay-state', (_e, state) => callback(state));
  },
  showMainWindow: () => ipcRenderer.send('overlay-show-main'),
});
