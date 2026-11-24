// lib/inprocess.js — the bubble window lives INSIDE the host Electron process.
//
// Hard rules kept from the standalone runtime:
//   · never call app.quit() — this process hosts the whole IDE
//   · never take the single-instance lock — the host already holds it
//   · every IPC channel is namespaced `dsh-hud:` so other plugins cannot collide

import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import hudCore from './hud-core.cjs';

const {
  WIN_WIDTH,
  WIN_HEIGHT,
  CHANNELS,
  DEFAULT_CONFIG,
  getControlPort,
  loadConfig,
  writeConfigFile,
  clampToDisplays,
  computeWindowBounds,
  getSystemFonts,
  createControlServer
} = hudCore;

export { DEFAULT_CONFIG };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(__dirname, '../runtime');
const INDEX_HTML = path.join(RUNTIME_DIR, 'index.html');
const PRELOAD_JS = path.join(RUNTIME_DIR, 'preload.js');

let cachedElectron;
let cachedElectronChecked = false;

/**
 * Electron main-process API when this plugin runs inside the desktop host, else null.
 * Deliberately does not throw: a plain-Node host simply takes the spawn fallback.
 */
export function loadElectron() {
  if (cachedElectronChecked) return cachedElectron;
  cachedElectronChecked = true;
  try {
    if (!process.versions?.electron) return (cachedElectron = null);
    const require_ = createRequire(import.meta.url);
    const mod = require_('electron');
    cachedElectron = mod?.BrowserWindow && mod?.app && mod?.ipcMain ? mod : null;
  } catch (e) {
    cachedElectron = null;
  }
  return cachedElectron;
}

/**
 * Create the in-process HUD. Returns null when this host is not Electron, so the caller can
 * fall back to spawning `runtime/main.js`.
 */
export function createInProcessHud({ logger, controlPort = getControlPort(), controlToken = '', oldToken = '' } = {}) {
  const el = loadElectron();
  if (!el) return null;
  if (!fs.existsSync(INDEX_HTML)) {
    logger?.warn?.('[dsh-hud] runtime/index.html missing — in-process HUD skipped');
    return null;
  }

  const { app, BrowserWindow, ipcMain, screen } = el;
  let win = null;
  let server = null;
  let disposed = false;
  let dragSaveTimer = null;
  let displayListenersBound = false;

  const loaded = loadConfig({ app, runtimeDir: RUNTIME_DIR });
  let config = loaded.config;
  const configFilePath = loaded.configPath;

  const persistConfig = () => {
    writeConfigFile(configFilePath, config);
  };

  const scheduleDragSave = () => {
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      persistConfig();
    }, 300);
  };

  const applyIgnoreMouse = () => {
    if (!win || win.isDestroyed()) return;
    if (config.isMovable) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  };

  const place = () => {
    if (!win || win.isDestroyed()) return;
    const bounds = computeWindowBounds(config, screen, { width: WIN_WIDTH, height: WIN_HEIGHT });
    win.setBounds(bounds);
  };

  const bindDisplayListeners = () => {
    if (displayListenersBound || !screen || typeof screen.on !== 'function') return;
    displayListenersBound = true;
    screen.on('display-removed', place);
    screen.on('display-metrics-changed', place);
    screen.on('display-added', place);
  };

  const unbindDisplayListeners = () => {
    if (!displayListenersBound || !screen || typeof screen.removeListener !== 'function') return;
    displayListenersBound = false;
    try {
      screen.removeListener('display-removed', place);
      screen.removeListener('display-metrics-changed', place);
      screen.removeListener('display-added', place);
    } catch (e) {}
  };

  const saveConfigPatch = (patch) => {
    const previous = { ...config };
    config = { ...config, ...patch };
    persistConfig();

    const posChanged =
      (patch.screenPosition !== undefined && patch.screenPosition !== previous.screenPosition) ||
      patch.customX !== undefined ||
      patch.customY !== undefined;
    if (posChanged) place();
    if (config.isMovable !== previous.isMovable) applyIgnoreMouse();
    if (win && !win.isDestroyed()) win.webContents.send(CHANNELS.CONFIG_UPDATED, config);
    return config;
  };

  const ensureWindow = () => {
    if (disposed) return null;
    if (win && !win.isDestroyed()) return win;
    if (!app.isReady()) return null;

    const bounds = computeWindowBounds(config, screen, { width: WIN_WIDTH, height: WIN_HEIGHT });

    win = new BrowserWindow({
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
        preload: PRELOAD_JS,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        paintWhenInitiallyHidden: false
      }
    });

    bindDisplayListeners();
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
    win.webContents.setBackgroundThrottling(false);

    win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.showInactive(); });
    win.webContents.on('did-finish-load', () => {
      applyIgnoreMouse();
      win.webContents.send(CHANNELS.CONFIG_UPDATED, config);
    });
    win.on('closed', () => { win = null; });
    win.loadFile(INDEX_HTML).catch((err) => logger?.warn?.(`[dsh-hud] load failed: ${err?.message ?? err}`));

    // 兜底：个别环境 ready-to-show 不触发
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    }, 600);

    return win;
  };

  const send = (channel, payload) => {
    const w = ensureWindow();
    if (!w) return false;
    try {
      w.webContents.send(channel, payload);
      return true;
    } catch (e) {
      return false;
    }
  };

  // Drag IPC: move uses setBounds (prevents Windows DPI size drift, no disk IO); end clamps & persists once
  const onDragMove = (_event, pos) => {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    if (!win || win.isDestroyed()) return;
    const x = Math.round(pos.x);
    const y = Math.round(pos.y);
    win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
    config = { ...config, screenPosition: 'custom', customX: x, customY: y };
  };

  const onDragEnd = (_event, pos) => {
    const rawX = pos && typeof pos.x === 'number' ? pos.x : config.customX;
    const rawY = pos && typeof pos.y === 'number' ? pos.y : config.customY;
    if (typeof rawX === 'number' && Number.isFinite(rawX) && typeof rawY === 'number' && Number.isFinite(rawY)) {
      const clamped = clampToDisplays(rawX, rawY, WIN_WIDTH, WIN_HEIGHT, screen);
      if (win && !win.isDestroyed()) win.setBounds(clamped);
      config = { ...config, screenPosition: 'custom', customX: clamped.x, customY: clamped.y };
    }
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    persistConfig();
  };

  const onDraggedLegacy = (_event, pos) => {
    onDragMove(_event, pos);
    scheduleDragSave();
  };

  try {
    ipcMain.on(CHANNELS.DRAG_MOVE, onDragMove);
    ipcMain.on(CHANNELS.DRAG_END, onDragEnd);
    ipcMain.on(CHANNELS.DRAGGED_LEGACY, onDraggedLegacy);
  } catch (e) {
    logger?.warn?.(`[dsh-hud] ipc bind failed: ${e?.message ?? e}`);
  }

  const askOldInstanceToQuit = (done) => {
    try {
      const headers = oldToken ? { 'X-DSH-HUD-Token': oldToken } : {};
      const req = http.request(
        { host: '127.0.0.1', port: controlPort, path: '/api/quit', method: 'POST', headers, timeout: 800 },
        (res) => { res.resume(); done(); }
      );
      req.on('error', () => done());
      req.on('timeout', () => { req.destroy(); done(); });
      req.end();
    } catch (e) {
      done();
    }
  };

  const startControlServer = (attempt = 0) => {
    try {
      server = createControlServer({
        token: controlToken,
        getConfig: () => config,
        onConfigPatch: (patch) => saveConfigPatch(patch),
        onTestBubble: ({ text, mode }) => {
          send(CHANNELS.EVENT, { type: 'testBubble', text, mode: mode || 'preview', timestamp: Date.now() });
        },
        onQuit: () => {
          // in-process HUD quits by unloading the plugin
        },
        getFonts: getSystemFonts
      });

      server.on('error', (err) => {
        if (err?.code !== 'EADDRINUSE') {
          logger?.warn?.(`[dsh-hud] control server error: ${err?.message ?? err}`);
          return;
        }
        if (attempt === 0) {
          logger?.info?.(`[dsh-hud] port ${controlPort} busy — asking the old standalone HUD to quit`);
          askOldInstanceToQuit(() => {
            try { server?.close(); } catch (e) {}
            setTimeout(() => startControlServer(1), 400);
          });
          return;
        }
        logger?.warn?.(`[dsh-hud] control port ${controlPort} still busy; settings page may talk to the old window`);
      });

      server.listen(controlPort, '127.0.0.1');
    } catch (e) {
      logger?.warn?.(`[dsh-hud] control server start failed: ${e?.message ?? e}`);
    }
  };

  if (app.isReady()) {
    ensureWindow();
    startControlServer();
  } else {
    app.whenReady().then(() => { ensureWindow(); startControlServer(); }).catch(() => {});
  }

  return {
    get mode() { return 'in-process'; },
    get config() { return config; },
    isAlive() { return Boolean(win && !win.isDestroyed()); },
    pushWorkStatus(state, task) {
      return send(CHANNELS.EVENT, { type: 'workStatus', state, task: task ?? null, timestamp: Date.now() });
    },
    pushNotify(event) {
      return send(CHANNELS.EVENT, { type: 'notify', event, timestamp: Date.now() });
    },
    pushWaitingStatus(waiting) {
      return send(CHANNELS.EVENT, {
        type: 'waitingStatus',
        count: waiting?.count ?? 0,
        items: Array.isArray(waiting?.items) ? waiting.items : [],
        timestamp: Date.now()
      });
    },
    pushTestBubble(text, mode = 'preview') {
      return send(CHANNELS.EVENT, { type: 'testBubble', text, mode, timestamp: Date.now() });
    },
    focusWindow() {
      if (win && !win.isDestroyed()) win.showInactive();
    },
    dispose() {
      disposed = true;
      if (dragSaveTimer) {
        clearTimeout(dragSaveTimer);
        dragSaveTimer = null;
        persistConfig();
      }
      unbindDisplayListeners();
      try {
        ipcMain.removeListener(CHANNELS.DRAG_MOVE, onDragMove);
        ipcMain.removeListener(CHANNELS.DRAG_END, onDragEnd);
        ipcMain.removeListener(CHANNELS.DRAGGED_LEGACY, onDraggedLegacy);
      } catch (e) {}
      try { server?.close(); } catch (e) {}
      server = null;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      win = null;
    }
  };
}
