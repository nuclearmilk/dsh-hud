// lib/inprocess.js — the bubble window lives INSIDE the host Electron process.
//
// Why: the desktop host is itself Electron, and plugins are loaded by the host's own cordis
// loader in its main process (see resources/app/lib/main.js). So there is no reason to spawn
// an external `electron` binary: `require('electron')` here already gives us BrowserWindow.
// This module is that path. `runtime/main.js` stays as the fallback for non-Electron hosts
// (CLI / web profile), where `loadElectron()` returns null and the caller spawns a runtime.
//
// Hard rules kept from the standalone runtime:
//   · never call app.quit() — this process hosts the whole IDE
//   · never take the single-instance lock — the host already holds it
//   · every IPC channel is namespaced `dsh-hud:` so other plugins cannot collide

import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = path.resolve(__dirname, '../runtime');
const INDEX_HTML = path.join(RUNTIME_DIR, 'index.html');
const CONFIG_NAME = 'dsh-hud-config.json';
const CONTROL_PORT = Number(process.env.DSH_HUD_CONTROL_PORT) || 52399;
const CH_CONFIG = 'dsh-hud:config-updated';
const CH_EVENT = 'dsh-hud:event';
const CH_DRAGGED = 'dsh-hud:window-dragged';

export const DEFAULT_CONFIG = {
  allRight: true,
  persistWorking: true,
  showRunningBubble: true,
  runningIdleTimeoutMin: 45,
  duration: 8500,
  screenPosition: 'right',
  customX: null,
  customY: null,
  isMovable: false,
  bubbleTheme: 'light',
  bubbleOpacity: 85,
  avatarType: 'preset-purple',
  avatarColor: '#8b5cf6',
  avatarGradient: 'linear-gradient(135deg, #a78bfa, #c084fc)',
  customAvatar: '',
  fontFamily: 'system',
  fontSize: 14
};

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

function configPath(app) {
  try {
    return path.join(app.getPath('userData'), CONFIG_NAME);
  } catch (e) {
    return path.join(os.homedir(), '.dsh', 'dsh-hud', CONFIG_NAME);
  }
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

function fileConfig(app) {
  const current = readJson(configPath(app));
  if (current) return { ...DEFAULT_CONFIG, ...current };
  // one-time migration from the pre-userData locations
  const legacy = [
    path.join(RUNTIME_DIR, 'config.json'),
    path.join(os.homedir(), '.dsh', 'dsh-hud', 'config.json'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Electron', CONFIG_NAME)
  ];
  for (const file of legacy) {
    const found = readJson(file);
    if (found) return { ...DEFAULT_CONFIG, ...found };
  }
  return { ...DEFAULT_CONFIG };
}

function systemFonts(cb) {
  const fallback = ['Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'PingFang SC', 'Arial', 'Segoe UI', 'Consolas'];
  if (process.platform !== 'win32') return cb(fallback);
  const cmd = `powershell -NoProfile -Command "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name"`;
  exec(cmd, { windowsHide: true }, (err, stdout) => {
    if (err || !stdout) return cb(fallback);
    const set = new Set();
    for (const raw of String(stdout).split(/\r?\n/)) {
      const clean = raw.replace(/\s*\([^)]*\)\s*;?/g, '').trim().replace(/( Bold| Italic| Light| Semibold| Black| Regular| Medium)+/gi, '').trim();
      if (clean && !clean.startsWith('@')) set.add(clean);
    }
    cb(set.size ? [...set].sort((a, b) => a.localeCompare(b)) : fallback);
  });
}

/**
 * Create the in-process HUD. Returns null when this host is not Electron, so the caller can
 * fall back to spawning `runtime/main.js`.
 */
export function createInProcessHud({ logger } = {}) {
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
  let config = fileConfig(app);

  const saveConfig = (next) => {
    config = { ...config, ...next };
    try {
      const file = configPath(app);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) { /* read-only userData: keep the in-memory value */ }
    return config;
  };

  const applyIgnoreMouse = () => {
    if (!win || win.isDestroyed()) return;
    if (config.isMovable) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  };

  const place = () => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = screen.getPrimaryDisplay().workArea;
    const w = 380, h = 680;
    let x = config.screenPosition === 'left' ? 16 : width - w - 16;
    let y = Math.round((height - h) / 2);
    if (config.screenPosition === 'custom' && typeof config.customX === 'number' && typeof config.customY === 'number') {
      x = config.customX;
      y = config.customY;
    }
    win.setBounds({ x, y, width: w, height: h });
  };

  const ensureWindow = () => {
    if (disposed) return null;
    if (win && !win.isDestroyed()) return win;
    if (!app.isReady()) return null;

    win = new BrowserWindow({
      width: 380,
      height: 680,
      show: false,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      focusable: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false,
        paintWhenInitiallyHidden: false
      }
    });

    place();
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
    win.webContents.setBackgroundThrottling(false);

    win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.showInactive(); });
    win.webContents.on('did-finish-load', () => {
      applyIgnoreMouse();
      win.webContents.send(CH_CONFIG, config);
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

  // renderer → host: drag to a new absolute position
  const onDragged = (_event, pos) => {
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
    if (!win || win.isDestroyed()) return;
    win.setPosition(Math.round(pos.x), Math.round(pos.y));
    saveConfig({ screenPosition: 'custom', customX: Math.round(pos.x), customY: Math.round(pos.y) });
  };
  try { ipcMain.on(CH_DRAGGED, onDragged); } catch (e) { logger?.warn?.(`[dsh-hud] ipc bind failed: ${e?.message ?? e}`); }

  // local control API for the settings page (same contract the standalone runtime serves)
  const startControlServer = (attempt = 0) => {
    try {
      server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        if (url.pathname === '/api/config' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(config));
        }
        if (url.pathname === '/api/fonts' && req.method === 'GET') {
          return systemFonts((fonts) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ fonts }));
          });
        }
        if (url.pathname === '/api/quit' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;                                  // in-process HUD quits by unloading the plugin
        }
        if (url.pathname === '/api/config' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              const patch = JSON.parse(body || '{}');
              const previous = { ...config };
              const next = saveConfig(patch);
              if (patch.screenPosition !== undefined && patch.screenPosition !== previous.screenPosition
                  || patch.customX !== undefined) place();
              if (next.isMovable !== previous.isMovable) applyIgnoreMouse();
              if (win && !win.isDestroyed()) win.webContents.send(CH_CONFIG, next);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, config: next }));
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message ?? String(e) }));
            }
          });
          return;
        }
        res.writeHead(404).end('Not Found');
      });

      server.on('error', (err) => {
        if (err?.code !== 'EADDRINUSE') {
          logger?.warn?.(`[dsh-hud] control server error: ${err?.message ?? err}`);
          return;
        }
        // A standalone HUD from an earlier version still owns the port. Ask it to leave, once.
        if (attempt === 0) {
          logger?.info?.(`[dsh-hud] port ${CONTROL_PORT} busy — asking the old standalone HUD to quit`);
          askOldInstanceToQuit(() => {
            try { server?.close(); } catch (e) {}
            setTimeout(() => startControlServer(1), 400);
          });
          return;
        }
        logger?.warn?.(`[dsh-hud] control port ${CONTROL_PORT} still busy; settings page may talk to the old window`);
      });

      server.listen(CONTROL_PORT, '127.0.0.1');
    } catch (e) {
      logger?.warn?.(`[dsh-hud] control server start failed: ${e?.message ?? e}`);
    }
  };

  const askOldInstanceToQuit = (done) => {
    try {
      const req = http.request(
        { host: '127.0.0.1', port: CONTROL_PORT, path: '/api/quit', method: 'POST', timeout: 800 },
        (res) => { res.resume(); done(); }
      );
      req.on('error', () => done());
      req.on('timeout', () => { req.destroy(); done(); });
      req.end();
    } catch (e) {
      done();
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
      return send(CH_EVENT, { type: 'workStatus', state, task: task ?? null, timestamp: Date.now() });
    },
    pushNotify(event) {
      return send(CH_EVENT, { type: 'notify', event, timestamp: Date.now() });
    },
    focusWindow() {
      if (win && !win.isDestroyed()) win.showInactive();
    },
    dispose() {
      disposed = true;
      try { ipcMain.removeListener(CH_DRAGGED, onDragged); } catch (e) {}
      try { server?.close(); } catch (e) {}
      server = null;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      win = null;
    }
  };
}
