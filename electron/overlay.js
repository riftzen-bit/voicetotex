'use strict';

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const PILL_WIDTH = 160;
const PILL_HEIGHT = 44;

let overlayWindow = null;
let mainWindowRef = null;
let currentState = 'ready';

function createOverlay(mainWindow) {
  mainWindowRef = mainWindow;

  overlayWindow = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    type: 'toolbar',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'overlay-preload.js'),
    },
  });

  overlayWindow.loadFile(path.join(__dirname, '..', 'src', 'overlay.html'));

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  ipcMain.on('overlay-show-main', () => {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.show();
      mainWindowRef.focus();
    }
  });

  positionOverlay();
}

function positionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  const display = screen.getPrimaryDisplay();
  const { width } = display.workArea;
  const x = Math.round((width - PILL_WIDTH) / 2);
  const y = 8;
  overlayWindow.setPosition(x, y);
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  positionOverlay();
  overlayWindow.showInactive();
  // Wayland fallback: showInactive may not work; ensure visibility
  if (!overlayWindow.isVisible()) overlayWindow.show();
  // Send state after showing — small delay to let renderer initialize
  setTimeout(() => sendStateToOverlay(), 50);
}

function hideOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.hide();
}

function sendStateToOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.webContents.send('overlay-state', currentState);
}

function updateOverlayState(state) {
  currentState = state;
  // Always store state; send to overlay only if visible
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (overlayWindow.isVisible()) {
    overlayWindow.webContents.send('overlay-state', state);
  }
}

function destroyOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
  }
  overlayWindow = null;
}

function isOverlayVisible() {
  return overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
}

module.exports = {
  createOverlay,
  showOverlay,
  hideOverlay,
  updateOverlayState,
  destroyOverlay,
  isOverlayVisible,
};
