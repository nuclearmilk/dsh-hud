'use strict';

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const {
  WIN_WIDTH,
  WIN_HEIGHT,
  CHANNELS,
  getControlPort,
  generateControlToken,
  writeStoredControlToken,
  isPidAlive,
  loadConfig,
  writeConfigFile,
  clampToDisplays,
  computeWindowBounds,
  getSystemFonts,
  createControlServer
} = require('../lib/hud-core.cjs');

let mainWindow = null;
let controlServer = null;
let dragSaveTimer = null;
let parentWatchTimer = null;
let displayListenersBound = false;

const CONTROL_PORT = getControlPort();
const CONTROL_TOKEN = process.env.DSH_HUD_CONTROL_TOKEN || (() => {
  const tok = generateControlToken();
  writeStoredControlToken(tok);
  return tok;
})();
const PARENT_PID = parseInt(process.env.DSH_HUD_PARENT_PID || '0', 10) || 0;

// 独立的 app 名：让 userData 落到 %APPDATA%/dsh-hud
try { app.setName('dsh-hud'); } catch (e) {}

const loadedConfig = loadConfig({ app, runtimeDir: __dirname });
let hudConfig = loadedConfig.config;
const CONFIG_PATH = loadedConfig.configPath;

function persistConfig() {
  writeConfigFile(CONFIG_PATH, hudConfig);
}

function scheduleDragSave() {
  if (dragSaveTimer) clearTimeout(dragSaveTimer);
  dragSaveTimer = setTimeout(() => {
    dragSaveTimer = null;
    persistConfig();
  }, 300);
}

function updateWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = computeWindowBounds(hudConfig, screen, { width: WIN_WIDTH, height: WIN_HEIGHT });
  mainWindow.setBounds(bounds);
}

function applyIgnoreMouseEvents() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (hudConfig.isMovable) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
}

function saveConfigPatch(patch) {
  const oldPos = hudConfig.screenPosition;
  const oldMovable = hudConfig.isMovable;
  hudConfig = { ...hudConfig, ...patch };
  persistConfig();

  const posChanged =
    (patch.screenPosition !== undefined && patch.screenPosition !== oldPos) ||
    patch.customX !== undefined ||
    patch.customY !== undefined;
  if (posChanged) {
    updateWindowPosition();
  }

  if (hudConfig.isMovable !== oldMovable) {
    applyIgnoreMouseEvents();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(CHANNELS.CONFIG_UPDATED, hudConfig);
  }
  return hudConfig;
}

function startLocalControlServer() {
  controlServer = createControlServer({
    token: CONTROL_TOKEN,
    getConfig: () => hudConfig,
    onConfigPatch: (patch) => saveConfigPatch(patch),
    onTestBubble: ({ text }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(CHANNELS.EVENT, {
          type: 'testBubble',
          text,
          timestamp: Date.now()
        });
      }
    },
    onQuit: () => {
      setTimeout(() => {
        try { app.quit(); } catch (e) {}
      }, 50);
    },
    getFonts: getSystemFonts
  });

  controlServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      try { app.quit(); } catch (e) {}
      return;
    }
    try { console.error('[dsh-hud] local server error:', err); } catch (e) {}
  });

  controlServer.listen(CONTROL_PORT, '127.0.0.1');
}

function bindDragIpcOnce() {
  ipcMain.removeAllListeners(CHANNELS.DRAG_MOVE);
  ipcMain.removeAllListeners(CHANNELS.DRAG_END);
  ipcMain.removeAllListeners(CHANNELS.DRAGGED_LEGACY);

  ipcMain.on(CHANNELS.DRAG_MOVE, (_event, pos) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    mainWindow.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
    hudConfig.screenPosition = 'custom';
    hudConfig.customX = x;
    hudConfig.customY = y;
  });

  ipcMain.on(CHANNELS.DRAG_END, (_event, pos) => {
    const rawX = pos && typeof pos.x === 'number' ? pos.x : hudConfig.customX;
    const rawY = pos && typeof pos.y === 'number' ? pos.y : hudConfig.customY;
    if (typeof rawX === 'number' && Number.isFinite(rawX) && typeof rawY === 'number' && Number.isFinite(rawY)) {
      const clamped = clampToDisplays(rawX, rawY, WIN_WIDTH, WIN_HEIGHT, screen);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds(clamped);
      hudConfig.screenPosition = 'custom';
      hudConfig.customX = clamped.x;
      hudConfig.customY = clamped.y;
    }
    if (dragSaveTimer) {
      clearTimeout(dragSaveTimer);
      dragSaveTimer = null;
    }
    persistConfig();
  });

  ipcMain.on(CHANNELS.DRAGGED_LEGACY, (_event, pos) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    mainWindow.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
    hudConfig.screenPosition = 'custom';
    hudConfig.customX = x;
    hudConfig.customY = y;
    scheduleDragSave();
  });
}

function createWindow() {
  const bounds = computeWindowBounds(hudConfig, screen, { width: WIN_WIDTH, height: WIN_HEIGHT });

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: false
    }
  });

  if (!displayListenersBound) {
    displayListenersBound = true;
    screen.on('display-removed', updateWindowPosition);
    screen.on('display-metrics-changed', updateWindowPosition);
    screen.on('display-added', updateWindowPosition);
  }

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.showInactive();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.showInactive();
      }
    }, 300);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    applyIgnoreMouseEvents();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.CONFIG_UPDATED, hudConfig);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  bindDragIpcOnce();
  startParentWatchdog();
  startEventPolling();
}

// ── Parent PID Watchdog ──────────────────────────────────────────────────────

function startParentWatchdog() {
  if (!PARENT_PID || parentWatchTimer) return;
  parentWatchTimer = setInterval(() => {
    if (!isPidAlive(PARENT_PID)) {
      isPolling = false;
      clearInterval(parentWatchTimer);
      parentWatchTimer = null;
      try { app.quit(); } catch (e) {}
    }
  }, 5000);
}

// ── DSH State Port Detection & Event Polling ─────────────────────────────────

let lastCounter = 0;
let lastWorkCounter = 0;
let lastNotifyCounter = 0;
let isPolling = false;

const ENV_DSH_PORT = parseInt(process.env.DSH_HUD_PORT || '0', 10) || 0;
let currentDshPort = ENV_DSH_PORT || 56150;
let activeEndpoint = '/dsh-hud/state';
let detectInFlight = null;

function listListeningPorts() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? 'netstat -ano | findstr 127.0.0.1 | findstr LISTENING'
      : 'lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || ss -ltn 2>/dev/null';

    exec(cmd, { windowsHide: true, timeout: 4000 }, (_err, stdout) => {
      const ports = [];
      if (stdout) {
        const regex = isWin
          ? /127\.0\.0\.1:(\d+)/g
          : /(?:127\.0\.0\.1|\[::1\]|\*|\d+\.\d+\.\d+\.\d+)[:.](\d+)/g;
        let m;
        while ((m = regex.exec(stdout)) !== null) {
          const p = parseInt(m[1], 10);
          if (!Number.isFinite(p) || p === CONTROL_PORT) continue;
          if (!ports.includes(p)) ports.push(p);
        }
      }
      resolve(ports);
    });
  });
}

function isValidStatePayload(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    typeof obj.counter === 'number' &&
    obj.sections &&
    typeof obj.sections === 'object'
  );
}

function probeEndpoint(port, endpoint, timeout = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const req = http.get(`http://127.0.0.1:${port}${endpoint}`, { timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return done(false);
      }
      const chunks = [];
      let total = 0;
      const MAX_PROBE_BYTES = 128 * 1024;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_PROBE_BYTES) {
          res.resume();
          req.destroy();
          return done(false);
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          done(isValidStatePayload(parsed));
        } catch (e) {
          done(false);
        }
      });
      res.on('error', () => done(false));
    });

    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
  });
}

async function testPort(port) {
  if (await probeEndpoint(port, '/dsh-hud/state')) {
    activeEndpoint = '/dsh-hud/state';
    return true;
  }
  if (await probeEndpoint(port, '/dsh-pet-7340/state')) {
    activeEndpoint = '/dsh-pet-7340/state';
    return true;
  }
  return false;
}

/** Single-flight port detection mutex to prevent concurrent netstat/lsof storms. */
function detectDshPort() {
  if (detectInFlight) return detectInFlight;

  detectInFlight = (async () => {
    try {
      if (await testPort(currentDshPort)) return currentDshPort;

      const listed = await listListeningPorts();
      const ports = [];
      if (ENV_DSH_PORT) ports.push(ENV_DSH_PORT);
      for (const p of [56150, 58974, 52327, 3080]) {
        if (!ports.includes(p)) ports.push(p);
      }
      for (const p of listed) {
        if (!ports.includes(p)) ports.push(p);
      }

      for (const port of ports) {
        if (await testPort(port)) {
          currentDshPort = port;
          console.log(`[dsh-hud] state endpoint detected: 127.0.0.1:${port}${activeEndpoint}`);
          return port;
        }
      }
      return null;
    } finally {
      detectInFlight = null;
    }
  })();

  return detectInFlight;
}

function fetchState(since = 0) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data);
    };

    const url = `http://127.0.0.1:${currentDshPort}${activeEndpoint}${since ? `?since=${since}&timeout=5000` : ''}`;
    const req = http.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (!isValidStatePayload(parsed)) {
            return finish(new Error('Invalid state payload'));
          }
          finish(null, parsed);
        } catch (e) {
          finish(e);
        }
      });
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    req.on('timeout', () => {
      req.destroy();
      finish(null, null);
    });
  });
}

async function startEventPolling() {
  if (isPolling) return;
  isPolling = true;

  let baselined = false;
  let consecutiveFailures = 0;

  while (isPolling) {
    try {
      const data = await fetchState(baselined ? lastCounter : 0);
      consecutiveFailures = 0;

      if (!baselined) {
        if (data) {
          if (data.counter) lastCounter = data.counter;
          if (data.sections?.workStatus?.counter) lastWorkCounter = data.sections.workStatus.counter;
          if (data.sections?.notify?.counter) lastNotifyCounter = data.sections.notify.counter;
          baselined = true;
        }
        continue;
      }

      if (data && data.counter) {
        handleStateUpdate(data);
        lastCounter = Math.max(lastCounter, data.counter);
      }
    } catch (e) {
      baselined = false;
      consecutiveFailures += 1;

      if (PARENT_PID && !isPidAlive(PARENT_PID)) {
        isPolling = false;
        try { app.quit(); } catch (_err) {}
        return;
      }

      // Exponential backoff (1.5s -> 3s -> 6s -> max 10s) and single-flight port detection
      const delayMs = Math.min(10000, 1500 * Math.pow(1.6, Math.min(consecutiveFailures - 1, 5)));
      await detectDshPort();
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function forwardEventItem(item) {
  if (!mainWindow || mainWindow.isDestroyed() || !item) return;

  if (item.kind === 'workStatus' && item.payload?.state) {
    mainWindow.webContents.send(CHANNELS.EVENT, {
      type: 'workStatus',
      state: item.payload.state,
      task: item.payload.task || null,
      timestamp: item.ts || Date.now()
    });
    return;
  }

  if (item.kind === 'notify' && item.payload?.event) {
    const frameTs = Number(item.ts || 0);
    const isStale = frameTs > 0 && Date.now() - frameTs > 60 * 1000;
    if (!isStale) {
      mainWindow.webContents.send(CHANNELS.EVENT, {
        type: 'notify',
        event: item.payload.event,
        timestamp: item.ts || Date.now()
      });
    }
  }
}

function handleStateUpdate(data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Prefer incremental event queue so rapid tool/call & tool/result bursts are never lost
  if (Array.isArray(data.events)) {
    for (const item of data.events) {
      if (typeof item.seq === 'number' && item.seq <= lastCounter) continue;
      forwardEventItem(item);
      if (item.kind === 'workStatus' && typeof item.seq === 'number') {
        lastWorkCounter = Math.max(lastWorkCounter, item.seq);
      } else if (item.kind === 'notify' && typeof item.seq === 'number') {
        lastNotifyCounter = Math.max(lastNotifyCounter, item.seq);
      }
    }
    return;
  }

  // Fallback for older /dsh-pet-7340/state endpoints without events[]
  const sections = data.sections || {};
  const workLeaf = sections.workStatus;
  const notifyLeaf = sections.notify;

  if (workLeaf && typeof workLeaf.counter === 'number' && workLeaf.counter > lastWorkCounter) {
    lastWorkCounter = workLeaf.counter;
    const workData = workLeaf.data;
    if (workData && workData.state) {
      mainWindow.webContents.send(CHANNELS.EVENT, {
        type: 'workStatus',
        state: workData.state,
        task: workData.task || null,
        timestamp: Date.now()
      });
    }
  }

  if (notifyLeaf && typeof notifyLeaf.counter === 'number' && notifyLeaf.counter > lastNotifyCounter) {
    lastNotifyCounter = notifyLeaf.counter;
    const event = notifyLeaf.data?.event;
    const frameTs = Number(notifyLeaf.data?.ts || 0);
    const isStale = frameTs > 0 && Date.now() - frameTs > 60 * 1000;
    if (event && !isStale) {
      mainWindow.webContents.send(CHANNELS.EVENT, {
        type: 'notify',
        event,
        timestamp: Date.now()
      });
    }
  }
}

// 单实例锁：避免 DSH 重启或重复加载时拉起多个 HUD 进程抢占端口
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    } catch (e) {}
  });

  app.whenReady().then(() => {
    startLocalControlServer();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => {
  isPolling = false;
  if (parentWatchTimer) {
    clearInterval(parentWatchTimer);
    parentWatchTimer = null;
  }
  if (dragSaveTimer) {
    clearTimeout(dragSaveTimer);
    dragSaveTimer = null;
    persistConfig();
  }
  try { controlServer?.close(); } catch (e) {}
});

app.on('window-all-closed', () => {
  isPolling = false;
  if (process.platform !== 'darwin') app.quit();
});
