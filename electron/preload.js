'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Allowed channels for incoming messages from main process
const LISTEN_CHANNELS = [
  'state-change',
  'transcript',
  'audio-level',
  'model-progress',
  'backend-status',
  'tray-command',
  'language-change',
];

// Track listeners for cleanup: Map<channel, Map<callback, wrapper>>
const listenerMap = new Map();

function addListener(channel, callback) {
  const wrapper = (_e, data) => callback(data);
  if (!listenerMap.has(channel)) {
    listenerMap.set(channel, new Map());
  }
  listenerMap.get(channel).set(callback, wrapper);
  ipcRenderer.on(channel, wrapper);
}

contextBridge.exposeInMainWorld('api', {
  // --- Config ---
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),

  // --- Data ---
  getAudioDevices: () => ipcRenderer.invoke('get-audio-devices'),
  getHistory: () => ipcRenderer.invoke('get-history'),

  // --- Window controls ---
  restartBackend: () => ipcRenderer.send('restart-backend'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),

  // --- Commands to backend ---
  sendCommand: (action, data) => ipcRenderer.invoke('send-command', action, data),
  exportFile: (content, defaultName) => ipcRenderer.invoke('export-file', content, defaultName),

  // --- Event listeners (main → renderer) ---
  onStateChange: (callback) => addListener('state-change', callback),
  onTranscript: (callback) => addListener('transcript', callback),
  onAudioLevel: (callback) => addListener('audio-level', callback),
  onModelProgress: (callback) => addListener('model-progress', callback),
  onBackendStatus: (callback) => addListener('backend-status', callback),

  // --- State forwarding to main process (for tray) ---
  notifyMainState: (state) => ipcRenderer.send('notify-state', state),

  // --- Tray / language commands from main process ---
  onTrayCommand: (callback) => addListener('tray-command', callback),
  onLanguageChange: (callback) => addListener('language-change', callback),

  // --- Cleanup ---
  removeListener: (channel, callback) => {
    if (!LISTEN_CHANNELS.includes(channel)) return;
    const channelMap = listenerMap.get(channel);
    if (!channelMap) return;
    const wrapper = channelMap.get(callback);
    if (wrapper) {
      ipcRenderer.removeListener(channel, wrapper);
      channelMap.delete(callback);
      if (channelMap.size === 0) listenerMap.delete(channel);
    }
  },
});
