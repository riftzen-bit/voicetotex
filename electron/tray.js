'use strict';

const { app, Menu, Tray, nativeImage } = require('electron');
const path = require('path');

// --- Module state ---
let tray = null;
let mainWindowRef = null;
let currentState = 'idle';
let currentLanguage = 'auto';

// --- Tray icon generation (SVG → nativeImage, no external files) ---
const STATE_ICON_COLORS = {
  idle: '#717171',
  ready: '#717171',
  recording: '#ff4444',
  processing: '#f0a500',
  error: '#ff4444',
  loading: '#717171',
};

function createTrayIcon(color) {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">',
    `<path fill="${color}" d="M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4z"/>`,
    `<path fill="${color}" d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.93V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.07A7 7 0 0 0 19 11z"/>`,
    '</svg>',
  ].join('');
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );
}

// --- Context menu ---
function buildContextMenu() {
  const win = mainWindowRef;
  const isRecording = currentState === 'recording';
  const isVisible = win && !win.isDestroyed() && win.isVisible();

  return Menu.buildFromTemplate([
    {
      label: isVisible ? 'Hide' : 'Show',
      click: () => toggleMainWindow(),
    },
    { type: 'separator' },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        if (win && !win.isDestroyed()) {
          const action = isRecording ? 'stop-recording' : 'start-recording';
          win.webContents.send('tray-command', action);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Language',
      submenu: [
        {
          label: 'Auto',
          type: 'radio',
          checked: currentLanguage === 'auto',
          click: () => sendLanguageChange('auto'),
        },
        {
          label: 'Vietnamese',
          type: 'radio',
          checked: currentLanguage === 'vi',
          click: () => sendLanguageChange('vi'),
        },
        {
          label: 'English',
          type: 'radio',
          checked: currentLanguage === 'en',
          click: () => sendLanguageChange('en'),
        },
      ],
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);
}

function toggleMainWindow() {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
}

function sendLanguageChange(lang) {
  currentLanguage = lang;
  const win = mainWindowRef;
  if (win && !win.isDestroyed()) {
    win.webContents.send('language-change', lang);
  }
}

function updateTrayLanguage(lang) {
  currentLanguage = lang;
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(buildContextMenu());
}

// --- Tray ---
function createTray(mainWindow) {
  mainWindowRef = mainWindow;

  const icon = createTrayIcon(STATE_ICON_COLORS.idle);
  tray = new Tray(icon);
  tray.setToolTip('VoiceToTex');
  tray.setContextMenu(buildContextMenu());

  // Left-click toggles main window visibility
  tray.on('click', () => toggleMainWindow());

  return tray;
}

function updateTrayState(state) {
  currentState = state;
  if (!tray || tray.isDestroyed()) return;

  const color = STATE_ICON_COLORS[state] || STATE_ICON_COLORS.idle;
  tray.setImage(createTrayIcon(color));
  tray.setContextMenu(buildContextMenu());
}

module.exports = { createTray, updateTrayState, updateTrayLanguage };
