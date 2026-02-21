'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { createTray, updateTrayState } = require('./tray');
const { createOverlay, showOverlay, hideOverlay, updateOverlayState, destroyOverlay } = require('./overlay');

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-wayland-ime');

let mainWindow = null;
let pythonProcess = null;
let backendPort = null;
let restartCount = 0;
const MAX_RESTARTS = 3;
const STARTUP_TIMEOUT_MS = 120_000;
let isQuitting = false;
let isSpawning = false;
let startupTimer = null;

function boundsFilePath() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFilePath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveBounds(bounds) {
  try {
    fs.writeFileSync(boundsFilePath(), JSON.stringify(bounds));
  } catch {
    /* non-critical */
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(startup);
}

function startup() {
  createMainWindow();
  createTray(mainWindow);
  createOverlay(mainWindow);
  spawnPythonBackend();
}

function createMainWindow() {
  const windowOptions = {
    width: 960,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    frame: false,
    resizable: true,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  };

  const saved = loadBounds();
  if (saved) {
    windowOptions.x = saved.x;
    windowOptions.y = saved.y;
    windowOptions.width = saved.width;
    windowOptions.height = saved.height;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  const persistBounds = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveBounds(mainWindow.getBounds());
    }
  };
  mainWindow.on('move', persistBounds);
  mainWindow.on('resize', persistBounds);

  mainWindow.on('show', () => {
    hideOverlay();
  });

  mainWindow.on('hide', () => {
    showOverlay();
  });

  mainWindow.on('minimize', () => {
    showOverlay();
  });

  mainWindow.on('restore', () => {
    hideOverlay();
  });

  mainWindow.on('focus', () => {
    hideOverlay();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function findPythonPath() {
  if (process.env.VOICETOTEX_PYTHON) {
    return process.env.VOICETOTEX_PYTHON;
  }
  return path.join(__dirname, '..', 'backend', '.venv', 'bin', 'python');
}

function killStaleBackend() {
  try {
    const { execSync } = require('child_process');
    const serverScript = path.join(__dirname, '..', 'backend', 'server.py');
    const pids = execSync(`pgrep -f "${serverScript}"`, { encoding: 'utf8', timeout: 3000 })
      .trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already dead */ }
    }
    if (pids.length > 0) {
      execSync('sleep 1', { timeout: 3000 });
    }
  } catch { /* no stale processes, or pgrep not found — fine */ }
}

function clearStartupTimer() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
}

function spawnPythonBackend() {
  if (isSpawning) {
    console.log('spawnPythonBackend() called while already spawning — skipping');
    return;
  }
  isSpawning = true;

  const pythonPath = findPythonPath();
  const serverScript = path.join(__dirname, '..', 'backend', 'server.py');
  const backendDir = path.join(__dirname, '..', 'backend');

  killStaleBackend();
  clearStartupTimer();
  sendToRenderer('backend-status', { status: 'starting' });

  pythonProcess = spawn(pythonPath, [serverScript], {
    cwd: backendDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });

  // Startup timeout — if backend doesn't send READY within limit, notify renderer
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (isSpawning && pythonProcess) {
      console.error(`Backend startup timed out after ${STARTUP_TIMEOUT_MS / 1000}s`);
      sendToRenderer('backend-status', {
        status: 'crashed',
        message: `Backend failed to start within ${STARTUP_TIMEOUT_MS / 1000}s. The model may be downloading — try restarting.`,
      });
    }
  }, STARTUP_TIMEOUT_MS);

  let stdoutBuffer = '';
  pythonProcess.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      const match = line.match(/^READY:(\d+)(?::(.+))?$/);
      if (match) {
        clearStartupTimer();
        isSpawning = false;
        backendPort = parseInt(match[1], 10);
        const authToken = match[2] || '';
        restartCount = 0;
        sendToRenderer('backend-status', { port: backendPort, authToken, status: 'ready' });
      }
      console.log(`[backend] ${line}`);
    }
  });

  pythonProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk}`);
  });

  pythonProcess.on('error', (err) => {
    clearStartupTimer();
    isSpawning = false;
    console.error(`Failed to spawn Python backend: ${err.message}`);
    pythonProcess = null;
    sendToRenderer('backend-status', { status: 'error', message: err.message });
  });

  pythonProcess.on('exit', (code, signal) => {
    clearStartupTimer();
    isSpawning = false;
    console.log(`Python backend exited: code=${code}, signal=${signal}`);
    pythonProcess = null;
    backendPort = null;

    if (!isQuitting && code !== 0 && restartCount < MAX_RESTARTS) {
      restartCount++;
      const delay = 1000 * restartCount;
      console.log(`Restarting backend (attempt ${restartCount}/${MAX_RESTARTS}) in ${delay}ms...`);
      sendToRenderer('backend-status', { status: 'restarting', attempt: restartCount });
      setTimeout(() => spawnPythonBackend(), delay);
    } else if (!isQuitting && code !== 0) {
      sendToRenderer('backend-status', { status: 'crashed', message: 'Max restarts exceeded' });
    }
  });
}

function killPythonBackend() {
  return new Promise((resolve) => {
    if (!pythonProcess) {
      resolve();
      return;
    }

    const proc = pythonProcess;
    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolve();
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}

ipcMain.on('notify-state', (_event, state) => {
  updateTrayState(state);
  updateOverlayState(state);
});

ipcMain.handle('get-config', () => ({}));
ipcMain.handle('set-config', (_event, _key, _value) => true);
ipcMain.handle('get-audio-devices', () => []);
ipcMain.handle('get-history', () => []);
ipcMain.handle('send-command', (_event, _action, _data) => null);

ipcMain.handle('export-file', async (_event, content, defaultName) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const ext = (defaultName || '').split('.').pop() || 'txt';
  const filterMap = {
    txt: { name: 'Text', extensions: ['txt'] },
    json: { name: 'JSON', extensions: ['json'] },
    srt: { name: 'SubRip Subtitles', extensions: ['srt'] },
    vtt: { name: 'WebVTT', extensions: ['vtt'] },
  };
  const filter = filterMap[ext] || filterMap.txt;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Transcripts',
    defaultPath: defaultName || 'transcripts.txt',
    filters: [filter, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return false;
  try {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.on('restart-backend', () => {
  restartCount = 0;
  clearStartupTimer();
  isSpawning = false;
  if (pythonProcess) {
    killPythonBackend().then(() => spawnPythonBackend());
  } else {
    spawnPythonBackend();
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

app.on('before-quit', async (e) => {
  if (!isQuitting) {
    e.preventDefault();
    isQuitting = true;
    destroyOverlay();
    await killPythonBackend();
    app.quit();
  }
});

app.on('window-all-closed', () => {});

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

module.exports = { sendToRenderer };
