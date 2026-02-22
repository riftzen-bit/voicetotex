'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync, execSync } = require('child_process');
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
let latestBackendStatus = { status: 'loading', message: 'Initializing' };

function sendBackendStatus(data) {
  latestBackendStatus = { ...latestBackendStatus, ...data };
  sendToRenderer('backend-status', latestBackendStatus);
}

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

function getBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'backend');
  }
  return path.join(__dirname, '..', 'backend');
}

function detectCudaLibPath(pythonPath) {
  try {
    return execSync(`"${pythonPath}" -c "
import site, os
for base in (site.getsitepackages() + [site.getusersitepackages()]):
    p = os.path.join(base, 'nvidia', 'cublas', 'lib')
    if os.path.isdir(p):
        print(p)
        break
"`, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}

function commandExists(command) {
  try {
    const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf8',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function findPythonPath() {
  if (process.env.VOICETOTEX_PYTHON) {
    return process.env.VOICETOTEX_PYTHON;
  }

  const backendDir = getBackendPath();
  const packagedVenvPython = path.join(backendDir, '.venv', 'bin', 'python');
  if (fs.existsSync(packagedVenvPython)) {
    return packagedVenvPython;
  }

  const userVenvPython = path.join(app.getPath('userData'), 'pyenv', 'bin', 'python');
  if (fs.existsSync(userVenvPython)) {
    return userVenvPython;
  }

  if (commandExists('python3')) return 'python3';
  if (commandExists('python')) return 'python';
  return packagedVenvPython;
}

function ensurePackagedPythonEnv(backendDir) {
  if (!app.isPackaged) return;

  const packagedVenvPython = path.join(backendDir, '.venv', 'bin', 'python');
  if (fs.existsSync(packagedVenvPython)) return;

  const requirementsPath = path.join(backendDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) return;

  const userVenvDir = path.join(app.getPath('userData'), 'pyenv');
  const userVenvPython = path.join(userVenvDir, 'bin', 'python');
  if (fs.existsSync(userVenvPython)) return;

  const basePython = commandExists('python3') ? 'python3' : (commandExists('python') ? 'python' : null);
  if (!basePython) {
    sendBackendStatus({ status: 'error', message: 'Python is not installed. Please install python3 and restart VoiceToTex.' });
    return;
  }

  sendBackendStatus({ status: 'starting', message: 'Preparing Python environment…' });
  const createResult = spawnSync(basePython, ['-m', 'venv', userVenvDir], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 180000,
  });
  if (createResult.status !== 0) {
    const err = (createResult.stderr || '').toString().trim();
    sendBackendStatus({ status: 'error', message: err || 'Failed to create Python environment.' });
    return;
  }

  const pipResult = spawnSync(userVenvPython, ['-m', 'pip', 'install', '-r', requirementsPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 900000,
  });
  if (pipResult.status !== 0) {
    const err = (pipResult.stderr || '').toString().trim();
    sendBackendStatus({ status: 'error', message: err || 'Failed to install Python dependencies.' });
  }
}

function killStaleBackend() {
  try {
    const serverScript = path.join(getBackendPath(), 'server.py');
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

  const backendDir = getBackendPath();
  const serverScript = path.join(backendDir, 'server.py');

  if (!fs.existsSync(serverScript)) {
    sendBackendStatus({ status: 'error', message: `Backend server missing: ${serverScript}` });
    isSpawning = false;
    return;
  }

  ensurePackagedPythonEnv(backendDir);
  const pythonPath = findPythonPath();

  killStaleBackend();
  clearStartupTimer();
  sendBackendStatus({ status: 'starting', message: 'Starting backend…' });

  const env = { ...process.env, PYTHONUNBUFFERED: '1' };
  const cudaPath = detectCudaLibPath(pythonPath);
  if (cudaPath) {
    env.LD_LIBRARY_PATH = cudaPath + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
  }

  pythonProcess = spawn(pythonPath, [serverScript], {
    cwd: backendDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  // Startup timeout — if backend doesn't send READY within limit, notify renderer
  startupTimer = setTimeout(() => {
    startupTimer = null;
    if (isSpawning && pythonProcess) {
      console.error(`Backend startup timed out after ${STARTUP_TIMEOUT_MS / 1000}s`);
      sendBackendStatus({
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
        sendBackendStatus({ port: backendPort, authToken, status: 'ready', message: 'Backend ready' });
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
    sendBackendStatus({ status: 'error', message: err.message });
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
      sendBackendStatus({ status: 'restarting', attempt: restartCount });
      setTimeout(() => spawnPythonBackend(), delay);
    } else if (!isQuitting && code !== 0) {
      sendBackendStatus({ status: 'crashed', message: 'Max restarts exceeded' });
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
ipcMain.handle('get-backend-status', () => latestBackendStatus);

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
